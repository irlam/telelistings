#!/usr/bin/env bash
# scripts/deploy.sh
# Automated deployment script for VPS scrapers
# This script copies the vps-scrapers folder to the VPS and runs installation
#
# Usage:
#   VPS_HOST=deploy.defecttracker.uk VPS_USER=root ./scripts/deploy.sh
#
# Important: For Cloudflare setups, use the DNS-only (gray cloud) hostname
# (e.g., deploy.defecttracker.uk) not the proxied web hostname.

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
VPS_HOST="${VPS_HOST:-}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
VPS_DIR="${VPS_DIR:-/opt/vps-scrapers}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check requirements
check_requirements() {
    if [ -z "$VPS_HOST" ]; then
        log_error "VPS_HOST environment variable is not set"
        echo "Usage: VPS_HOST=deploy.defecttracker.uk VPS_USER=username ./scripts/deploy.sh"
        exit 1
    fi
    
    if ! command -v rsync &> /dev/null; then
        log_error "rsync is not installed. Please install it first."
        exit 1
    fi
    
    if ! command -v ssh &> /dev/null; then
        log_error "ssh is not installed. Please install it first."
        exit 1
    fi
}

# Test SSH connection
test_connection() {
    log_info "Testing SSH connection to $VPS_USER@$VPS_HOST:$VPS_PORT..."
    
    if ssh -p "$VPS_PORT" -o ConnectTimeout=10 -o BatchMode=yes "$VPS_USER@$VPS_HOST" exit 2>/dev/null; then
        log_success "SSH connection successful"
    else
        log_error "SSH connection failed. Please check:"
        echo "  - VPS host is correct and reachable"
        echo "  - SSH key is configured (ssh-copy-id $VPS_USER@$VPS_HOST)"
        echo "  - VPS port is correct (default: 22)"
        exit 1
    fi
}

# Create remote directory
create_remote_directory() {
    log_info "Creating remote directory $VPS_DIR..."
    ssh -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" "mkdir -p $VPS_DIR"
    log_success "Remote directory created"
}

# Sync files to VPS
sync_files() {
    log_info "Syncing files to VPS..."
    
    rsync -avz \
        --delete \
        --exclude 'node_modules' \
        --exclude '.env' \
        --exclude '.git' \
        --exclude 'logs' \
        --exclude '*.log' \
        -e "ssh -p $VPS_PORT" \
        "$LOCAL_DIR/" \
        "$VPS_USER@$VPS_HOST:$VPS_DIR/"
    
    log_success "Files synced successfully"
}

# Make scripts executable
make_scripts_executable() {
    log_info "Making scripts executable..."
    ssh -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" "chmod +x $VPS_DIR/scripts/*.sh"
    log_success "Scripts are now executable"
}

# Run installation
run_installation() {
    log_info "Running installation on VPS..."
    
    ssh -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" "cd $VPS_DIR && VPS_DIR=$VPS_DIR bash scripts/install-dependencies.sh"
    
    log_success "Installation completed"
}

# Main deployment flow
main() {
    echo "======================================"
    echo "VPS Scrapers Deployment Script"
    echo "======================================"
    echo ""
    echo "Target: $VPS_USER@$VPS_HOST:$VPS_PORT"
    echo "Remote directory: $VPS_DIR"
    echo "Local directory: $LOCAL_DIR"
    echo ""
    
    check_requirements
    test_connection
    create_remote_directory
    sync_files
    make_scripts_executable
    run_installation
    
    echo ""
    log_success "Deployment completed successfully!"
    echo ""
    log_info "Your VPS scrapers are now installed at: $VPS_DIR"
    echo ""
    log_info "To start the service:"
    echo "  ssh $VPS_USER@$VPS_HOST"
    echo "  sudo systemctl start vps-scrapers"
    echo "  sudo systemctl enable vps-scrapers"
    echo ""
}

main "$@"
