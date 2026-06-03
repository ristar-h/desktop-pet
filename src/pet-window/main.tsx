import ReactDOM from "react-dom/client";
import { PetWindow } from "./PetWindow";

// 注意：故意不开 React.StrictMode。
// PetWindow 重度依赖 Tauri 异步 IPC（loadConfig / loadAllActions / event listener）
// + 状态机 setInterval + walk RAF。StrictMode 在 dev 模式会双挂载组件，
// 而 init() 是异步的——unmount 时 stateMachineRef 还是 null，cleanup 啥都没清掉，
// 结果两个 init() 并发跑：两套状态机、12 个 event listener，导致 pet:switch-avatar 等
// 事件触发时 handler 跑两遍，hidePetSync / showPetFadeIn 两套并行 → 频闪。
// production build 本来就没有 StrictMode 双挂载，dev 关掉它行为和 prod 一致。
ReactDOM.createRoot(document.getElementById("root")!).render(<PetWindow />);
