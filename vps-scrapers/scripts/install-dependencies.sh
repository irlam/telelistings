#!/usr/bin/env bash
# scripts/install-dependencies.sh
# Complete installation script for VPS scrapers
# This script installs all required dependencies for running the VPS scrapers

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
VPS_DIR="${VPS_DIR:-/opt/vps-scrapers}"
NODE_VERSION="${NODE_VERSION:-18}"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [ "$EUID" -eq 0 ]; then
        log_warning "Running as root. This is not recommended but will continue."
    fi
}

# Detect Linux distribution
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        VERSION=$VERSION_ID
    else
        DISTRO="unknown"
        VERSION="unknown"
    fi
    log_info "Detected OS: $DISTRO $VERSION"
}

# Install Node.js if not present or version is old
install_nodejs() {
    log_info "Checking Node.js installation..."
    
    if command -v node &> /dev/null; then
        NODE_CURRENT=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_CURRENT" -ge "$NODE_VERSION" ]; then
            log_success "Node.js v$(node -v) is already installed"
            return 0
        else
            log_warning "Node.js v$(node -v) is too old. Need v${NODE_VERSION}+"
        fi
    fi
    
    log_info "Installing Node.js v${NODE_VERSION}..."
    
    if [ "$DISTRO" = "ubuntu" ] || [ "$DISTRO" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [ "$DISTRO" = "centos" ] || [ "$DISTRO" = "rhel" ] || [ "$DISTRO" = "fedora" ]; then
        # Use dnf for modern RHEL/CentOS/Fedora, fallback to yum for older versions
        if command -v dnf &> /dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | sudo bash -
            sudo dnf install -y nodejs
        else
            curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | sudo bash -
            sudo yum install -y nodejs
        fi
    else
        log_error "Unsupported distribution for automatic Node.js installation"
        log_info "Please install Node.js v${NODE_VERSION}+ manually"
        return 1
    fi
    
    log_success "Node.js v$(node -v) installed successfully"
}

# Install Chrome/Chromium and dependencies
install_chrome() {
    log_info "Installing Chrome/Chromium and dependencies..."
    
    if [ "$DISTRO" = "ubuntu" ] || [ "$DISTRO" = "debian" ]; then
        log_info "Updating package lists..."
        sudo apt-get update -y
        
        log_info "Installing Chrome dependencies..."
        
        # Ubuntu 24.04+ uses time64 packages with t64 suffix
        # Detect if we're on Ubuntu 24.04 or newer
        UBUNTU_24_04_OR_NEWER=false
        if [ "$DISTRO" = "ubuntu" ] && [ -n "$VERSION" ]; then
            # Extract major version number (e.g., "24.04" -> "24")
            VERSION_NUM=$(echo "$VERSION" | cut -d'.' -f1)
            if [ -n "$VERSION_NUM" ] && [ "$VERSION_NUM" -ge 24 ] 2>/dev/null; then
                UBUNTU_24_04_OR_NEWER=true
            fi
        fi
        
        # Common packages that work on all versions
        COMMON_PACKAGES="ca-certificates fonts-liberation libnss3 lsb-release xdg-utils wget"
        COMMON_PACKAGES="$COMMON_PACKAGES gnupg apt-transport-https libxss1 libx11-6 libx11-xcb1"
        COMMON_PACKAGES="$COMMON_PACKAGES libxcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1"
        COMMON_PACKAGES="$COMMON_PACKAGES libgdk-pixbuf2.0-0 libpango-1.0-0 libpangocairo-1.0-0"
        COMMON_PACKAGES="$COMMON_PACKAGES libstdc++6 fonts-noto-color-emoji"
        
        # Version-specific packages (time64 variants for Ubuntu 24.04+)
        if [ "$UBUNTU_24_04_OR_NEWER" = true ]; then
            VERSION_SPECIFIC_PACKAGES="libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libgtk-3-0t64"
        else
            VERSION_SPECIFIC_PACKAGES="libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgtk-3-0"
        fi
        
        sudo apt-get install -y --no-install-recommends \
            $COMMON_PACKAGES \
            $VERSION_SPECIFIC_PACKAGES || {
                log_error "Failed to install Chrome dependencies"
                return 1
            }
        
        log_info "Adding Google Chrome repository..."
        wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg
        echo "deb [signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | \
            sudo tee /etc/apt/sources.list.d/google-chrome.list > /dev/null
        
        sudo apt-get update -y
        
        log_info "Installing google-chrome-stable..."
        if sudo apt-get install -y google-chrome-stable; then
            log_success "Google Chrome installed successfully"
        else
            log_warning "Failed to install Google Chrome, trying Chromium..."
            sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
        fi
        
    elif [ "$DISTRO" = "centos" ] || [ "$DISTRO" = "rhel" ] || [ "$DISTRO" = "fedora" ]; then
        log_info "Installing Chromium..."
        if command -v dnf &> /dev/null; then
            sudo dnf install -y chromium
        else
            sudo yum install -y chromium
        fi
    else
        log_error "Unsupported distribution for automatic Chrome installation"
        return 1
    fi
    
    # Detect installed browser
    if command -v google-chrome-stable &> /dev/null; then
        CHROME_PATH=$(which google-chrome-stable)
        log_success "Chrome installed at: $CHROME_PATH"
        google-chrome-stable --version
    elif command -v google-chrome &> /dev/null; then
        CHROME_PATH=$(which google-chrome)
        log_success "Chrome installed at: $CHROME_PATH"
        google-chrome --version
    elif command -v chromium-browser &> /dev/null; then
        CHROME_PATH=$(which chromium-browser)
        log_success "Chromium installed at: $CHROME_PATH"
        chromium-browser --version
    elif command -v chromium &> /dev/null; then
        CHROME_PATH=$(which chromium)
        log_success "Chromium installed at: $CHROME_PATH"
        chromium --version
    else
        log_error "No Chrome/Chromium binary found after installation"
        return 1
    fi
}

# Install npm dependencies
install_npm_dependencies() {
    log_info "Installing npm dependencies..."
    
    if [ ! -d "$VPS_DIR" ]; then
        log_error "VPS directory $VPS_DIR does not exist"
        return 1
    fi
    
    cd "$VPS_DIR"
    
    if [ ! -f "package.json" ]; then
        log_error "package.json not found in $VPS_DIR"
        return 1
    fi
    
    npm install --production
    log_success "npm dependencies installed successfully"
}

# Configure environment
configure_environment() {
    log_info "Configuring environment..."
    
    if [ ! -f "$VPS_DIR/.env" ]; then
        if [ -f "$VPS_DIR/.env.example" ]; then
            cp "$VPS_DIR/.env.example" "$VPS_DIR/.env"
            log_success "Created .env file from .env.example"
            log_warning "Please edit $VPS_DIR/.env to set your API keys"
        else
            log_warning ".env.example not found, skipping .env creation"
        fi
    else
        log_info ".env file already exists"
    fi
    
    # Set Chrome path in .env if detected
    if [ -n "${CHROME_PATH:-}" ]; then
        if ! grep -q "PUPPETEER_EXECUTABLE_PATH" "$VPS_DIR/.env" 2>/dev/null; then
            echo "PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH" >> "$VPS_DIR/.env"
            log_success "Set PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH in .env"
        fi
    fi
}

# Setup systemd service
setup_systemd_service() {
    log_info "Setting up systemd service..."
    
    if [ ! -f "$VPS_DIR/vps-scrapers.service" ]; then
        log_warning "vps-scrapers.service file not found, skipping systemd setup"
        return 0
    fi
    
    # Update service file with correct paths and user
    CURRENT_USER=${SUDO_USER:-$(whoami)}
    SERVICE_FILE="$VPS_DIR/vps-scrapers.service"
    
    # Create a temporary service file with correct values
    sudo cp "$SERVICE_FILE" /etc/systemd/system/vps-scrapers.service
    
    # Update the service file
    sudo sed -i "s|User=.*|User=$CURRENT_USER|g" /etc/systemd/system/vps-scrapers.service
    sudo sed -i "s|Group=.*|Group=$CURRENT_USER|g" /etc/systemd/system/vps-scrapers.service
    sudo sed -i "s|WorkingDirectory=.*|WorkingDirectory=$VPS_DIR|g" /etc/systemd/system/vps-scrapers.service
    sudo sed -i "s|ExecStart=.*|ExecStart=$(which node) $VPS_DIR/server.js|g" /etc/systemd/system/vps-scrapers.service
    
    sudo systemctl daemon-reload
    log_success "Systemd service configured"
    
    log_info "You can now manage the service with:"
    echo "  sudo systemctl start vps-scrapers"
    echo "  sudo systemctl enable vps-scrapers"
    echo "  sudo systemctl status vps-scrapers"
}

# Run health check
run_health_check() {
    log_info "Running health check..."
    
    cd "$VPS_DIR"
    
    if [ -f "scripts/health.js" ]; then
        if node scripts/health.js; then
            log_success "Health check passed!"
        else
            log_warning "Health check failed. Please check the logs."
        fi
    else
        log_warning "Health check script not found, skipping"
    fi
}

# Main installation flow
main() {
    echo "======================================"
    echo "VPS Scrapers Installation Script"
    echo "======================================"
    echo ""
    
    check_root
    detect_distro
    
    log_info "Starting installation in $VPS_DIR"
    echo ""
    
    # Run installation steps
    install_nodejs || { log_error "Node.js installation failed"; exit 1; }
    install_chrome || { log_error "Chrome installation failed"; exit 1; }
    install_npm_dependencies || { log_error "npm dependencies installation failed"; exit 1; }
    configure_environment
    setup_systemd_service
    
    echo ""
    log_success "Installation completed successfully!"
    echo ""
    
    # Run health check
    run_health_check
    
    echo ""
    log_info "Next steps:"
    echo "  1. Edit $VPS_DIR/.env to configure your API keys"
    echo "  2. Start the service: sudo systemctl start vps-scrapers"
    echo "  3. Enable auto-start: sudo systemctl enable vps-scrapers"
    echo "  4. Check logs: sudo journalctl -u vps-scrapers -f"
    echo ""
}

# Run main function
main "$@"
