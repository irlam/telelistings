// lib/ssh-client.js
// SSH Client for remote VPS operations
// Provides functions for connecting to VPS, executing commands, and transferring files

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

/**
 * SSH Client wrapper for VPS operations
 */
class SSHClient {
  constructor(config) {
    let privateKey;
    if (config.privateKeyPath) {
      try {
        privateKey = fs.readFileSync(config.privateKeyPath);
      } catch (error) {
        throw new Error(`Failed to read SSH private key from ${config.privateKeyPath}: ${error.message}`);
      }
    }
    
    this.config = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password,
      privateKey: privateKey,
      readyTimeout: config.timeout || 20000  // Reduced from 30s to 20s to fail faster
    };
    this.client = null;
  }

  /**
   * Test SSH connection to VPS
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    try {
      await this.connect();
      await this.disconnect();
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Connect to SSH server
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.client = new Client();
      
      // Set up timeout handler
      const timeout = setTimeout(() => {
        if (this.client) {
          this.client.end();
        }
        reject(new Error(`Connection timeout after ${this.config.readyTimeout}ms. The VPS host may be unreachable or not accepting SSH connections.`));
      }, this.config.readyTimeout);
      
      this.client.on('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client.on('error', (err) => {
        clearTimeout(timeout);
        // Enhance error message with more context
        const enhancedMessage = `SSH connection failed: ${err.message}. Please verify that:\n` +
          `- The VPS host (${this.config.host}:${this.config.port}) is reachable\n` +
          `- SSH service is running on the VPS\n` +
          `- Your credentials are correct\n` +
          `- Firewall allows SSH connections`;
        reject(new Error(enhancedMessage));
      });

      try {
        this.client.connect(this.config);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to initiate SSH connection: ${err.message}`));
      }
    });
  }

  /**
   * Disconnect from SSH server
   */
  disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  /**
   * Execute a command on the remote server
   * @param {string} command - Command to execute
   * @param {object} options - Options for execution
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
   */
  async executeCommand(command, options = {}) {
    if (!this.client) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.exec(command, options, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          resolve({ stdout, stderr, exitCode: code });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }

  /**
   * Execute multiple commands sequentially
   * @param {string[]} commands - Array of commands to execute
   * @returns {Promise<Array<{command: string, stdout: string, stderr: string, exitCode: number}>>}
   */
  async executeCommands(commands) {
    if (!this.client) {
      await this.connect();
    }

    const results = [];
    
    for (const command of commands) {
      try {
        const result = await this.executeCommand(command);
        results.push({ command, ...result });
      } catch (error) {
        results.push({ 
          command, 
          stdout: '', 
          stderr: error.message, 
          exitCode: -1 
        });
      }
    }

    return results;
  }

  /**
   * Upload a file to the remote server using SFTP
   * @param {string} localPath - Local file path
   * @param {string} remotePath - Remote file path
   * @returns {Promise<void>}
   */
  async uploadFile(localPath, remotePath) {
    if (!this.client) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        sftp.fastPut(localPath, remotePath, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }

  /**
   * Upload a directory to the remote server recursively
   * @param {string} localDir - Local directory path
   * @param {string} remoteDir - Remote directory path
   * @returns {Promise<{uploaded: number, failed: number, errors: Array}>}
   */
  async uploadDirectory(localDir, remoteDir) {
    if (!this.client) {
      await this.connect();
    }

    const results = { uploaded: 0, failed: 0, errors: [] };

    return new Promise((resolve, reject) => {
      this.client.sftp(async (err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          // Create remote directory if it doesn't exist
          await this.executeCommand(`mkdir -p ${remoteDir}`);

          // Get all files in the local directory
          const files = this.getAllFiles(localDir);

          for (const file of files) {
            const relativePath = path.relative(localDir, file);
            const remoteFilePath = path.posix.join(remoteDir, relativePath);
            const remoteFileDir = path.posix.dirname(remoteFilePath);

            try {
              // Create remote directory for this file
              await this.executeCommand(`mkdir -p ${remoteFileDir}`);

              // Upload the file
              await new Promise((resolveUpload, rejectUpload) => {
                sftp.fastPut(file, remoteFilePath, (uploadErr) => {
                  if (uploadErr) {
                    rejectUpload(uploadErr);
                  } else {
                    resolveUpload();
                  }
                });
              });

              results.uploaded++;
            } catch (uploadError) {
              results.failed++;
              results.errors.push({ file: relativePath, error: uploadError.message });
            }
          }

          resolve(results);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Get all files in a directory recursively
   * @param {string} dirPath - Directory path
   * @param {string[]} arrayOfFiles - Accumulator for recursive calls
   * @returns {string[]} Array of file paths
   */
  getAllFiles(dirPath, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);

    files.forEach((file) => {
      const filePath = path.join(dirPath, file);
      
      if (fs.statSync(filePath).isDirectory()) {
        // Skip node_modules and hidden directories
        if (!file.startsWith('.') && file !== 'node_modules') {
          arrayOfFiles = this.getAllFiles(filePath, arrayOfFiles);
        }
      } else {
        arrayOfFiles.push(filePath);
      }
    });

    return arrayOfFiles;
  }

  /**
   * Download a file from the remote server
   * @param {string} remotePath - Remote file path
   * @param {string} localPath - Local file path
   * @returns {Promise<void>}
   */
  async downloadFile(remotePath, localPath) {
    if (!this.client) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }

        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  }

  /**
   * Check if a file or directory exists on the remote server
   * @param {string} remotePath - Remote path to check
   * @returns {Promise<boolean>}
   */
  async exists(remotePath) {
    try {
      const result = await this.executeCommand(`test -e ${remotePath} && echo "exists" || echo "not_exists"`);
      return result.stdout.trim() === 'exists';
    } catch (error) {
      return false;
    }
  }
}

module.exports = SSHClient;
