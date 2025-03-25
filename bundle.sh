#!/bin/bash

# Get the extension name and version from manifest.json
EXTENSION_NAME=$(cat manifest.json | grep -o '"name": *"[^"]*"' | cut -d'"' -f4)
VERSION=$(cat manifest.json | grep -o '"version": *"[^"]*"' | cut -d'"' -f4)

# Create a temporary directory for bundling
TEMP_DIR="temp_bundle_${EXTENSION_NAME// /_}"
mkdir -p "$TEMP_DIR"

# Copy all necessary files
echo "Copying files..."
cp manifest.json "$TEMP_DIR/"
cp content.js "$TEMP_DIR/"
cp popup.html "$TEMP_DIR/"
cp popup.js "$TEMP_DIR/"
cp background.js "$TEMP_DIR/"
cp -r icons "$TEMP_DIR/"

# Create ZIP file
ZIP_NAME="${EXTENSION_NAME// /_}_v${VERSION}.zip"
echo "Creating ZIP file: $ZIP_NAME"
cd "$TEMP_DIR"
zip -r "../$ZIP_NAME" *
cd ..

# Clean up
echo "Cleaning up..."
rm -rf "$TEMP_DIR"

echo "Done! Extension has been bundled into $ZIP_NAME"
echo "You can now upload this ZIP file to the Chrome Web Store" 