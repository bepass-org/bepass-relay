#!/bin/bash

# Function to print characters with delay
print_with_delay() {
    local text="$1"
    local delay="$2"
    for ((i = 0; i < ${#text}; i++)); do
        echo -n "${text:i:1}"
        sleep "$delay"
    done
}

# Introduction  animation
echo
print_with_delay "**** Thanks for Becoming a Volunteer Maintainer ****" 0.02
echo

# Check if the service is already installed
if systemctl is-active --quiet cfb.service; then
    echo "Service is already installed and active."
    exit 0
fi


# Check the operating system
if [[ $(uname -s) != "Linux" ]]; then
    echo "Not supported OS: $(uname -s)"
    exit 1
fi

# Step 1: Install Golang and clone the repository
sudo apt-get update
sudo apt-get install -y golang git
sudo mkdir -p /opt
cd /opt || exit 1
sudo git clone https://github.com/uoosef/cf-bepass.git
cd cf-bepass || exit 1
go build relay.go

# Step 2: Create a systemd service for Bepass
cat > /etc/systemd/system/cfb.service <<EOL
[Unit]
Description=CF Bepass Service

[Service]
ExecStart=/opt/cf-bepass/relay

[Install]
WantedBy=multi-user.target
EOL

# Reload systemd to read the new unit file
sudo systemctl daemon-reload

# Step 3: Start and enable the service
sudo systemctl start cfb.service
sudo systemctl enable cfb.service

# Check the status of the service
systemctl status cfb.service

# Display message after installation
if systemctl is-active --quiet cfb.service; then
    echo
    echo "Thanks. Service installation completed and it is ✔️ Active."
    echo
fi
