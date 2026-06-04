use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::path::Path;

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

/// 递归 copy 目录（std::fs 没原生提供）
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

/// 首次启动 / 升级时确保默认形象已就位 + config 已初始化。
/// 幂等：默认形象目录已存在则不覆盖；config 已有 currentAvatarId 则不动。
fn ensure_default_avatar_and_config<R: tauri::Runtime>(app: &tauri::App<R>) -> std::io::Result<()> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::create_dir_all(&app_data_dir)?;

    // ---- 1. 安装默认形象（avatars/default/）----
    let default_avatar_dst = app_data_dir.join("avatars").join("default");
    if !default_avatar_dst.exists() {
        let resource_path = app
            .path()
            .resolve("resources/default-avatar", tauri::path::BaseDirectory::Resource)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        if resource_path.exists() {
            copy_dir_recursive(&resource_path, &default_avatar_dst)?;
            println!("[Setup] default avatar installed → {:?}", default_avatar_dst);
        } else {
            eprintln!("[Setup] default avatar resource not found at {:?}", resource_path);
        }
    }

    // ---- 2. 初始化 / 修补 config.json ----
    let config_path = app_data_dir.join("config.json");
    let mut config: serde_json::Value = if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(t) => serde_json::from_str(&t).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };

    let mut changed = false;
    // 没 currentAvatarId → 用默认形象
    if config.get("currentAvatarId").and_then(|v| v.as_str()).is_none() {
        config["currentAvatarId"] = serde_json::Value::String("default".to_string());
        changed = true;
    }
    // 既然默认形象已安装，老用户也直接放行
    if !config.get("onboardingCompleted").and_then(|v| v.as_bool()).unwrap_or(false) {
        config["onboardingCompleted"] = serde_json::Value::Bool(true);
        changed = true;
    }
    if changed {
        std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;
        println!("[Setup] config.json initialized / patched");
    }

    Ok(())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            // 首次启动 / 升级：装默认形象 + 修补 config.json
            // 失败也不要 panic，桌宠就用 Onboarding 兜底
            // ============================================================
            if let Err(e) = ensure_default_avatar_and_config(app) {
                eprintln!("[Setup] ensure_default_avatar_and_config failed: {:?}", e);
            }

            // ============================================================
            // 现在所有用户都视为「已 onboard」（默认形象保证存在）
            // 同时 show 主面板（首启动用户能看到 AvatarManager）和桌宠（用户立即能看到伙伴）
            // ============================================================
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.show();
            }
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
            }

            // Configure pet window for always-on-top (macOS specific)
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{
                    NSWindow, NSWindowCollectionBehavior,
                };
                use cocoa::base::id;
                use cocoa::foundation::NSUInteger;
                use objc::runtime::{Class, Object};
                use objc::{msg_send, sel, sel_impl};

                // NSWindowStyleMaskNonactivatingPanel = 1 << 7
                // cocoa 0.26 的 NSWindowStyleMask 枚举没暴露这个值，只能用字面量。
                // Apple 头文件里的常量值是稳定的，跨 macOS 版本不会变。
                const NS_NONACTIVATING_PANEL_MASK: NSUInteger = 1 << 7;

                // libobjc.dylib 的 runtime 函数：在 objc 0.2 crate 里没 re-export，
                // 但符号在系统库里随时可链。改 isa（"morph"）的唯一公开 API。
                // [obj setClass:] 不是 NSObject 的公开实例方法，msg_send 发过去会
                // unrecognized selector → abort，必须走这个 runtime 入口。
                extern "C" {
                    fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
                }

                if let Some(pet_window) = app.get_webview_window("pet") {
                    // ns_window() 返回 Result：罕见情况下窗口已 drop 会报错；
                    // 改用 if let Ok 兜底，避免 unwrap 在 setup 阶段 panic 整个应用
                    if let Ok(ns_handle) = pet_window.ns_window() {
                        let ns_window = ns_handle as id;
                        unsafe {
                            // ============================================================
                            // 关键：把 NSWindow morph 成 NSPanel + nonactivatingPanel
                            //
                            // 单纯靠 setLevel(1500) + FullScreenAuxiliary 在 NSWindow 上不可靠——
                            // Chrome / 视频播放器进入"原生全屏"会被分到独立的 fullscreen Space，
                            // 普通 NSWindow 即使带 FullScreenAuxiliary 也常常被排除在外。
                            //
                            // NSPanel 是 macOS 给"工具调色板/浮动面板"专门设计的子类，配合
                            // nonactivatingPanel style mask 可以稳定地浮在所有 fullscreen 应用之上，
                            // 同时点击不会抢焦点（前台 app 不会被切换走）。
                            //
                            // setClass: 用 objc 运行时把 isa 指针指向 NSPanel —— NSPanel 没有新增
                            // 实例变量，只是 override 一些方法，内存布局兼容，安全。这是 Tauri /
                            // electron-overlay 等项目通用的 hack。
                            // ============================================================
                            if let Some(panel_class) = Class::get("NSPanel") {
                                // 用 runtime 函数改 isa，不是 msg_send（见上面 extern 注释）
                                object_setClass(ns_window as *mut Object, panel_class);
                                let current_mask: NSUInteger = msg_send![ns_window, styleMask];
                                let new_mask = current_mask | NS_NONACTIVATING_PANEL_MASK;
                                let _: () = msg_send![ns_window, setStyleMask: new_mask];

                                // 让 nonactivating panel 即便不成为 key window 也能收到 mouseMoved
                                // 事件 → WebKit 才能稳定派发 cursor:grab 给系统，鼠标 hover 上来
                                // 才能从箭头变成小手。否则 macOS 会立刻把 WebKit 设的 cursor
                                // 重置回默认箭头。
                                let _: () = msg_send![ns_window, setAcceptsMouseMovedEvents: true];
                            } else {
                                eprintln!("[Setup] NSPanel class not found, fullscreen overlay may fail");
                            }

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
            // macOS: 点击 Dock 图标 → 同时显示主面板 + 桌宠 + 把主面板拉回主页
            // 用户预期：从 Dock 重新唤起 = 把伙伴 + 操作面板都拿回来，看到的是形象列表（主页）。
            // 注意：不能用 has_visible_windows 做 guard——桌宠几乎一直在桌面上飘着，
            // 这个标志几乎永远是 true，主面板被红叉隐藏后再点 Dock 就召不回来了。
            // show() / set_focus() 对已可见窗口是幂等的，无脑两个都 show + 把主面板提到最前。
            // 同时 emit 事件让 React 端把 view 重置回 avatar-manager（避免上次停留在 redesign /
            //   settings 页 + ⌘W hide 后，dock 唤起还看到上传照片 / 设置页）。
            #[cfg(target_os = "macos")]
            {
                if let RunEvent::Reopen { .. } = &event {
                    if let Some(pet_window) = app_handle.get_webview_window("pet") {
                        let _ = pet_window.show();
                    }
                    if let Some(main_window) = app_handle.get_webview_window("main") {
                        let _ = main_window.show();
                        let _ = main_window.unminimize();
                        let _ = main_window.set_focus();
                        let _ = main_window.emit("app:reset-to-home", ());
                    }
                }
            }
            // 兜底，避免未使用警告
            let _ = (&app_handle, &event);
        });
}
