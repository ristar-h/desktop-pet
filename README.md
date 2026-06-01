# Desktop Pet

Turn your photo into a cute chibi desktop companion that lives on your screen!

## Features

- Upload your photo → AI generates a cute Q-version desktop pet
- Always visible on top of all windows (even fullscreen apps)
- 8 animated actions: idle, walk, sleep, happy, sad, stretch, looking around, drag
- Autonomous behavior: walks around, sleeps when you're away, reacts when clicked
- Right-click menu for settings, resizing, and regenerating
- Lightweight (~10MB installer)

## Download

Go to [Releases](../../releases) and download:
- **macOS (Apple Silicon):** `Desktop-Pet_x.x.x_aarch64.dmg`
- **Windows:** `Desktop-Pet_x.x.x_x64-setup.exe`

## Quick Start

1. Download and install the app
2. Launch it — the onboarding wizard will guide you
3. Enter your [Evolink API Key](https://docs.evolink.ai/cn/quickstart) (uses GPT-Image-2 model)
4. Upload a clear photo of yourself
5. Wait 3-5 minutes for generation
6. Your pet appears on the desktop!

## How It Works

The app uses AI (GPT-Image-2 via Evolink API) to generate sprite sheet animations based on your photo. Each action (idle, walk, sleep, etc.) is generated as a series of frames that are then sliced, background-removed, and aligned to create smooth animations.

### Pet Behavior

Your pet has autonomous behavior driven by a state machine:

| State | Trigger | Duration |
|-------|---------|----------|
| Idle | Default state | Until next event |
| Walk | No input for 1-2 min | 15-25 seconds, moves across screen |
| Sleep | No input for 5 min | Until you move mouse/type |
| Happy | Click on pet | ~1.6s one-shot |
| Sad | Sleeping > 30 min | ~2s one-shot |
| Stretch | Wake up from sleep | ~2s one-shot |
| Looking Around | After walk (30% chance) | ~2.7s one-shot |
| Drag | Hold and drag pet | While dragging |

### Right-Click Menu

- Change Avatar — upload a new photo
- Regenerate — regenerate with current photo
- Settings — change API key, pet size
- Size — Small (120px) / Medium (180px) / Large (240px)
- About — version info
- Quit — close the app

## Getting an API Key

1. Go to [docs.evolink.ai](https://docs.evolink.ai/cn/quickstart)
2. Sign up / Log in
3. Create an API Key
4. The app uses the `gpt-image-2` model (~$0.02-0.05 per action generated)
5. Total first-time cost: ~$0.20-0.40 for all 8 actions

## Development

### Prerequisites

- Node.js 20+
- Rust (latest stable)
- Platform-specific dependencies for [Tauri](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Tech Stack

- [Tauri 2](https://v2.tauri.app) — Desktop framework
- [React 19](https://react.dev) — UI
- [TypeScript](https://typescriptlang.org) — Type safety
- [Tailwind CSS 4](https://tailwindcss.com) — Styling
- [Vite 7](https://vite.dev) — Build tool

## License

MIT
