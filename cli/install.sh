#!/bin/sh
set -e

REPO="draganescu/hisohiso"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="hisohiso"

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="hisohiso-${os}-${arch}"

  printf "Installing hisohiso (%s/%s)...\n" "$os" "$arch"

  # Get latest release download URL
  download_url="https://github.com/${REPO}/releases/latest/download/${asset}"

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Download
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$download_url" -o "$tmp"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$download_url"
  else
    echo "Error: curl or wget required" >&2
    exit 1
  fi

  # Install
  mv "$tmp" "${INSTALL_DIR}/${BINARY_NAME}"
  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

  printf "\nInstalled to %s/%s\n" "$INSTALL_DIR" "$BINARY_NAME"

  # Check if install dir is in PATH
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      shell_config="$(detect_shell_config)"
      if [ -n "$shell_config" ]; then
        printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$shell_config"
        printf "Added %s to PATH in %s\n" "$INSTALL_DIR" "$shell_config"
        printf "Run: source %s  (or open a new terminal)\n" "$shell_config"
      else
        printf "\nAdd this to your shell config:\n"
        printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      fi
      ;;
  esac

  printf "\nDone. Run: hisohiso pair --server https://hisohiso.org\n"
}

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

detect_shell_config() {
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash)
      # Prefer .bashrc on Linux, .bash_profile on macOS
      if [ "$(uname -s)" = "Darwin" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "" ;;
  esac
}

main
