# Udemy Transcript Extractor

A Chrome extension that extracts and saves transcripts from Udemy courses.

## Features

- Automatically extracts transcripts from all video lectures in a Udemy course
- Navigates through course content programmatically
- Organizes transcripts by section and lecture
- Download the complete transcript as a text file

## Installation

Since this extension is not published to the Chrome Web Store yet, you'll need to install it in developer mode:

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top-right corner)
4. Click "Load unpacked" and select the folder containing this extension
5. The extension should now appear in your Chrome toolbar

## Usage

1. Navigate to any Udemy course page
2. Click the extension icon in your Chrome toolbar
3. Click the "Record Course Transcripts" button
4. Confirm by clicking "Continue" in the dialog
5. The extension will automatically navigate through the course lectures and extract transcripts
6. Once completed, a notification will appear
7. Click the extension icon again and use the "Download Transcripts" button to save the transcripts

## How It Works

This extension:
1. Extracts the course structure from the Udemy sidebar
2. Navigates to each video lecture in sequence
3. Opens the transcript panel for each lecture
4. Extracts the transcript text
5. Organizes and saves the transcripts by section and lecture
6. Provides a download option for the complete transcript

## Notes

- The extension requires you to be already logged in to Udemy and have access to the course
- The browser window must remain open while the extraction is in progress
- Large courses may take some time to process completely
- Only video lectures with available transcripts will be included

## License

MIT

## Icons

The extension currently uses placeholder icons. For a production version, you should replace them with custom icons. 