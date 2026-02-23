#!/bin/bash

# Prompt user for input
read -p "Enter your DigitalOcean Droplet IP: " DROPLET_IP
read -p "Enter the deployment directory on the droplet: " DEPLOY_DIR

# Connect to the droplet and set up the environment
ssh root@$DROPLET_IP << EOF
  echo "Updating packages..."
  apt update -y
  apt upgrade -y
  apt install -y php-cli nginx git unzip composer

  echo "Cloning the repository..."
  git clone https://github.com/draganescu/hisohiso.git $DEPLOY_DIR
  cd $DEPLOY_DIR

  echo "Installing dependencies with Composer..."
  composer install

  echo "Configuring permissions..."
  chmod -R 755 $DEPLOY_DIR

  echo "Restarting services..."
  systemctl restart nginx
  echo "Setup completed! Application is deployed to $DEPLOY_DIR"
EOF
