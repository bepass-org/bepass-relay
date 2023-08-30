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

# Function to uninstall the service
uninstall_service() {
    sudo systemctl stop cfb.service
    sudo systemctl disable cfb.service
    sudo rm /etc/systemd/system/cfb.service
    sudo rm -rf /opt/cf-bepass
    echo "Service has been uninstalled."
}

# Introduction animation
echo
print_with_delay "**** Thanks for Becoming a Volunteer Maintainer ****" 0.03
echo

# Display options
echo
echo "Select an option:"
echo "------------------------------"
echo "1) Install service"
echo "2) Uninstall service"
echo "3) Set IP On Worker"
echo "------------------------------"
read -p "Please select: " option

if [[ $option == "1" ]]; then
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
    CGO_ENABLED=0 go build -ldflags '-s -w' -trimpath *.go

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
    systemctl daemon-reload

    # Step 3: Start and enable the service
    systemctl start cfb.service
    systemctl enable cfb.service

    # Check the status of the service
    systemctl status cfb.service

    # Display installation completion message
    if systemctl is-active --quiet cfb.service; then
        echo
        echo "Service installation completed and is ✔️ Active."
        echo
    fi
 
elif [[ $option == "2" ]]; then
    if systemctl is-active --quiet cfb.service; then
        read -p "Do you want to uninstall the service? (yes/no): " uninstall_option
        if [[ $uninstall_option == "yes" ]]; then
            uninstall_service
        else
            echo "Uninstallation canceled."
        fi
    else
        echo "Service is not installed."
    fi
    
elif [[ $option == "3" ]]; then
    if systemctl is-active --quiet cfb.service; then
        read -p "Do you want to add your IP to the worker domain (Set A record)? (yes/no): " create_record_option
        if [[ $create_record_option == "yes" ]]; then
            # Retrieve the server's public IPv4 address
            ipv4_address=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}')            

            # Cloudflare API variables
            zone_id="98dc00aea2fe235d9f3b08ec2f5932f2"  # Replace with your actual zone ID
            api_token="NnO5sXHbIaW03qxZFeBlnOCJH30g9ore_Q0Xu2qm"  # Replace with your actual API token
            email="onlycloudflare@gmail.com"  # Replace with your actual email
            subdomain="iran"

            # Prepare the data for the API request
            data='{
                "type": "A",
                "name": "'"$subdomain"'",
                "content": "'"$ipv4_address"'",
                "proxied": false
            }'

            # Send the API request
            result=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records" \
                -H "Authorization: Bearer $api_token" \
                -H "Content-Type: application/json" \
                --data "$data")

            if [[ $result == *"\"success\":true"* ]]; then
                echo "A record added successfully with IP: $ipv4_address"
            else
                if [[ $result == *"\"code\":81057"* ]]; then
                    echo "A record already exists with IP: $ipv4_address "
                else
                    echo "Failed to add A record."
                fi
            fi
        else
            echo "A record creation canceled."
        fi
    else
        echo "Service is not installed."
    fi
else
    echo "Invalid option selected."
fi
