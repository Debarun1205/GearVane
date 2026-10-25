# Getting Started & Installation

GearVane releases precompiled, signed executables across all supported operating systems.

---

## Download Links

Download the latest version directly from the [GitHub Releases Page](https://github.com/Debarun1205/GearVane/releases/latest) or the [Official Website](https://debarun1205.github.io/GearVane/):

| Platform | Format | Filename |
| :--- | :--- | :--- |
| **Windows** | Setup Installer | `GearVane-Setup-0.4.2.exe` |
| **Windows** | Portable Executable | `GearVane-0.4.2-win-x64-portable.exe` |
| **macOS** | Apple Silicon DMG | `GearVane-0.4.2-arm64.dmg` |
| **Linux** | Universal AppImage | `GearVane-0.4.2-x86_64.AppImage` |
| **Linux** | Debian / Ubuntu DEB | `gearvane_0.4.2_amd64.deb` |
| **Android** | Android Package | `gearvane-0.4.2.apk` |
| **VS Code** | Extension Package | `gearvane-0.4.2.vsix` |

---

## Installation Steps

### Windows
1. Download `GearVane-Setup-0.4.2.exe`.
2. Run the installer. It installs the application into `%LOCALAPPDATA%\Programs\GearVane` and registers file associations.
3. Alternatively, download the portable version `GearVane-0.4.2-win-x64-portable.exe` to run anywhere without installation.

### macOS
1. Download `GearVane-0.4.2-arm64.dmg`.
2. Open the DMG and drag **GearVane.app** into `/Applications`.
3. Launch GearVane from Launchpad or Spotlight.

### Linux
1. **AppImage**:
   ```bash
   chmod +x GearVane-0.4.2-x86_64.AppImage
   ./GearVane-0.4.2-x86_64.AppImage
   ```
2. **Debian/Ubuntu**:
   ```bash
   sudo dpkg -i gearvane_0.4.2_amd64.deb
   sudo apt-get install -f
   ```

### VS Code Extension
1. Download `gearvane-0.4.2.vsix`.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click `...` in the top-right corner and select **Install from VSIX...**, or run:
   ```bash
   code --install-extension gearvane-0.4.2.vsix
   ```

---

## Onboarding Wizard

Upon launching GearVane for the first time, you are guided through a 3-step onboarding flow:
1. **Hardware Assessment**: Automatically measures CPU threads, RAM, and GPU VRAM to determine your machine's local capability tier.
2. **Offline Weights Verification**: Confirms presence of the 2 pre-installed embedded weights (`SmolLM2-360M` and `Qwen2.5-Coder-0.5B`).
3. **Model Selection**: Optionally choose to download recommended mid-tier models (`Qwen2.5-7B` or `Qwen3-8B`) or connect external API providers.
