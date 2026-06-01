use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Get seconds since last user input (mouse/keyboard)
#[tauri::command]
fn get_idle_seconds() -> f64 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(
                stateID: u32,
                eventType: u32,
            ) -> f64;
        }
        // kCGEventSourceStateCombinedSessionState = 0
        // kCGAnyInputEventType = 0xFFFFFFFF
        unsafe { CGEventSourceSecondsSinceLastEventType(0, 0xFFFFFFFF) }
    }

    #[cfg(target_os = "windows")]
    {
        use winapi::um::winuser::{GetLastInputInfo, LASTINPUTINFO};
        use winapi::um::sysinfoapi::GetTickCount;
        unsafe {
            let mut lii = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            GetLastInputInfo(&mut lii);
            let idle_ms = GetTickCount().wrapping_sub(lii.dwTime);
            idle_ms as f64 / 1000.0
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        0.0
    }
}

/// 读取 config.json 中的 onboardingCompleted 标志（启动时决定显示哪个窗口）
fn read_onboarding_completed<R: tauri::Runtime>(app: &tauri::App<R>) -> bool {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return false,
    };
    let config_path = app_data_dir.join("config.json");
    if !config_path.exists() {
        return false;
    }
    let text = match std::fs::read_to_string(&config_path) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return false,
    };
    json.get("onboardingCompleted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let running = Arc::new(AtomicBool::new(true));
    // 后台 idle 上报线程的退出标志：让 .run 闭包也能在 Exit 时关停
    let running_for_run = running.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_idle_seconds])
        .on_window_event(|window, event| {
            // 拦截 main 窗口的关闭事件：改为隐藏，桌宠仍然存活
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let running_clone = running.clone();

            // ============================================================
            // 读取 config.json，决定首次启动显示 main 还是 pet 窗口
            // ============================================================
            // 不依赖 JS：Rust 直接读盘，避免 webview 懒加载导致桌宠不显示
            let onboarded = read_onboarding_completed(app);
            println!("[Setup] onboardingCompleted = {}", onboarded);
            if onboarded {
                if let Some(pet) = app.get_webview_window("pet") {
                    match pet.show() {
                        Ok(_) => println!("[Setup] pet window shown"),
                        Err(e) => eprintln!("[Setup] failed to show pet: {:?}", e),
                    }
                } else {
                    eprintln!("[Setup] pet window not found");
                }
            } else {
                if let Some(main) = app.get_webview_window("main") {
                    match main.show() {
                        Ok(_) => println!("[Setup] main window shown (onboarding)"),
                        Err(e) => eprintln!("[Setup] failed to show main: {:?}", e),
                    }
                } else {
                    eprintln!("[Setup] main window not found");
                }
            }

            // Configure pet window for always-on-top (macOS specific)
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{
                    NSWindow, NSWindowCollectionBehavior,
                };
                use cocoa::base::id;

                if let Some(pet_window) = app.get_webview_window("pet") {
                    // ns_window() 返回 Result：罕见情况下窗口已 drop 会报错；
                    // 改用 if let Ok 兜底，避免 unwrap 在 setup 阶段 panic 整个应用
                    if let Ok(ns_handle) = pet_window.ns_window() {
                        let ns_window = ns_handle as id;
                        unsafe {
                            // Level 1500: above fullscreen apps
                            ns_window.setLevel_(1500);

                            // Visible across all Spaces, stays in place
                            ns_window.setCollectionBehavior_(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
                            );
                        }
                    } else {
                        eprintln!("[Setup] failed to get ns_window for pet");
                    }
                }
            }

            // Spawn background thread: poll idle time every 3s, emit to pet window
            std::thread::spawn(move || {
                while running_clone.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_secs(3));

                    let idle_secs = get_idle_seconds();
                    let _ = app_handle.emit_to("pet", "system:idle-time", idle_secs);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app_handle, event| {
            // 应用退出：关停后台 idle 上报线程，避免它向已 drop 的 app_handle emit
            if matches!(event, RunEvent::Exit) {
                running_for_run.store(false, Ordering::Relaxed);
            }
            // macOS: 点击 Dock 图标 → 显示 main 窗口
            #[cfg(target_os = "macos")]
            {
                if let RunEvent::Reopen { has_visible_windows, .. } = &event {
                    if !*has_visible_windows {
                        if let Some(main_window) = app_handle.get_webview_window("main") {
                            let _ = main_window.show();
                            let _ = main_window.set_focus();
                        }
                    }
                }
            }
            // 兜底，避免未使用警告
            let _ = (&app_handle, &event);
        });
}
