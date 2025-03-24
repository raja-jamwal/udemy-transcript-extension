document.addEventListener('DOMContentLoaded', function() {
  const startRecordingBtn = document.getElementById('start-recording');
  const stopRecordingBtn = document.getElementById('stop-recording');
  const downloadTranscriptsBtn = document.getElementById('download-transcripts');
  const clearTranscriptsBtn = document.getElementById('clear-transcripts');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const confirmYesBtn = document.getElementById('confirm-yes');
  const confirmNoBtn = document.getElementById('confirm-no');
  const mainControls = document.getElementById('main-controls');
  const statusDiv = document.getElementById('status');
  
  // Initialize the extension popup
  initializePopup();

  function initializePopup() {
    // Show loading status initially
    showStatus('Checking extension status...', 'info');
    
    // Check if there's a recording in progress and saved transcript data
    chrome.runtime.sendMessage({action: 'getRecordingStatus'}, function(response) {
      // Check for chrome runtime error (extension restarted, etc.)
      if (chrome.runtime.lastError) {
        console.error('Chrome runtime error:', chrome.runtime.lastError);
        showStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
        mainControls.classList.remove('hidden');
        return;
      }
      
      if (response && response.isRecording) {
        startRecordingBtn.classList.add('hidden');
        stopRecordingBtn.classList.remove('hidden');
        
        // Show current recording status
        const sectionIndex = response.currentSectionIndex + 1;
        const lectureIndex = response.currentLectureIndex + 1;
        showStatus(`Recording in progress (Section ${sectionIndex}, Lecture ${lectureIndex})`, 'info');
      } else {
        startRecordingBtn.classList.remove('hidden');
        stopRecordingBtn.classList.add('hidden');
        
        // If there was a last error, show it
        if (response && response.lastError) {
          showStatus(`Last error: ${response.lastError}`, 'error');
        } else {
          // Hide status message if no issues
          statusDiv.classList.add('hidden');
        }
      }
      
      // Always show main controls after checking status
      mainControls.classList.remove('hidden');
      
      // Check for transcript data
      checkForTranscriptData();
    });
  }

  function checkForTranscriptData() {
    chrome.storage.local.get(['transcriptData'], function(result) {
      if (chrome.runtime.lastError) {
        console.error('Error accessing storage:', chrome.runtime.lastError);
        return;
      }
      
      if (result.transcriptData && Object.keys(result.transcriptData).length > 0) {
        downloadTranscriptsBtn.classList.remove('hidden');
        clearTranscriptsBtn.classList.remove('hidden');
        
        // Debug info
        let sectionCount = Object.keys(result.transcriptData).length;
        let lectureCount = 0;
        for (const section in result.transcriptData) {
          lectureCount += Object.keys(result.transcriptData[section]).length;
        }
        console.log(`Found ${sectionCount} sections with ${lectureCount} lectures in storage`);
      } else {
        downloadTranscriptsBtn.classList.add('hidden');
        clearTranscriptsBtn.classList.add('hidden');
      }
    });
  }

  // Start recording button clicked
  startRecordingBtn.addEventListener('click', function() {
    // First check if we're on a valid Udemy page
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (!tabs || !tabs[0]) {
        showStatus('Cannot access current tab information', 'error');
        return;
      }
      
      const currentUrl = tabs[0].url;
      if (!currentUrl.includes('udemy.com/course') && !currentUrl.includes('udemy.com/learn')) {
        showStatus('Please navigate to a Udemy course page first', 'error');
        return;
      }
      
      // Show confirmation dialog
      mainControls.classList.add('hidden');
      confirmationDialog.classList.remove('hidden');
    });
  });

  // Stop recording button clicked
  stopRecordingBtn.addEventListener('click', function() {
    showStatus('Stopping recording...', 'info');
    chrome.runtime.sendMessage({action: 'stopRecording'}, function(response) {
      if (chrome.runtime.lastError) {
        showStatus('Error stopping recording: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      
      if (response && response.success) {
        showStatus('Recording stopped successfully', 'success');
        startRecordingBtn.classList.remove('hidden');
        stopRecordingBtn.classList.add('hidden');
        checkForTranscriptData();
      } else {
        showStatus('Failed to stop recording', 'error');
      }
    });
  });

  // Confirm recording
  confirmYesBtn.addEventListener('click', function() {
    confirmationDialog.classList.add('hidden');
    startRecording();
  });

  // Cancel recording
  confirmNoBtn.addEventListener('click', function() {
    confirmationDialog.classList.add('hidden');
    mainControls.classList.remove('hidden');
  });

  // Download transcripts
  downloadTranscriptsBtn.addEventListener('click', function() {
    showStatus('Preparing transcript download...', 'info');
    chrome.storage.local.get(['transcriptData'], function(result) {
      if (chrome.runtime.lastError) {
        showStatus('Error accessing storage: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      
      if (result.transcriptData && Object.keys(result.transcriptData).length > 0) {
        const transcriptText = formatTranscriptData(result.transcriptData);
        downloadAsFile(transcriptText, 'udemy_transcript.txt');
        showStatus('Download started!', 'success');
        
        // Clear status after 3 seconds
        setTimeout(() => {
          statusDiv.classList.add('hidden');
        }, 3000);
      } else {
        showStatus('No transcript data found', 'error');
      }
    });
  });

  // Clear transcripts
  clearTranscriptsBtn.addEventListener('click', function() {
    if (confirm('Are you sure you want to clear all transcript data? This cannot be undone.')) {
      showStatus('Clearing transcript data...', 'info');
      chrome.runtime.sendMessage({action: 'clearTranscriptData'}, function(response) {
        if (chrome.runtime.lastError) {
          showStatus('Error clearing data: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        
        if (response && response.success) {
          showStatus('Transcript data cleared successfully', 'success');
          downloadTranscriptsBtn.classList.add('hidden');
          clearTranscriptsBtn.classList.add('hidden');
        } else {
          showStatus('Failed to clear transcript data', 'error');
        }
      });
    }
  });

  function startRecording() {
    // Send message to the background script to start recording
    showStatus('Starting recording process...', 'info');
    
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (!tabs || !tabs[0]) {
        showStatus('Cannot access current tab information', 'error');
        mainControls.classList.remove('hidden');
        return;
      }
      
      const currentUrl = tabs[0].url;
      if (!currentUrl.includes('udemy.com/course') && !currentUrl.includes('udemy.com/learn')) {
        showStatus('Please navigate to a Udemy course page first', 'error');
        mainControls.classList.remove('hidden');
        return;
      }
      
      chrome.runtime.sendMessage({action: 'startRecording', courseTab: tabs[0].id}, function(response) {
        if (chrome.runtime.lastError) {
          showStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
          mainControls.classList.remove('hidden');
          return;
        }
        
        if (response && response.success) {
          showStatus('Recording started! You can close this popup.', 'success');
          
          // Update UI
          startRecordingBtn.classList.add('hidden');
          stopRecordingBtn.classList.remove('hidden');
          
          // Clear after 3 seconds and show main controls
          setTimeout(() => {
            statusDiv.classList.add('hidden');
            mainControls.classList.remove('hidden');
          }, 3000);
        } else {
          const errorMsg = response && response.error 
            ? `Failed to start recording: ${response.error}` 
            : 'Failed to start recording';
          showStatus(errorMsg, 'error');
          mainControls.classList.remove('hidden');
        }
      });
    });
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = ''; // Clear existing classes
    statusDiv.classList.add(type);
    statusDiv.classList.remove('hidden');
    console.log(`Status: [${type}] ${message}`);
  }

  function formatTranscriptData(data) {
    let text = '';
    
    // Course title if available
    const courseTitleElement = document.querySelector('h1.udlite-heading-xl');
    if (courseTitleElement) {
      const courseTitle = courseTitleElement.textContent.trim();
      text += `# ${courseTitle}\n\n`;
    } else {
      text += '# Udemy Course Transcript\n\n';
    }

    // Add timestamp
    const now = new Date();
    text += `*Transcript extracted on ${now.toLocaleDateString()} at ${now.toLocaleTimeString()}*\n\n`;
    
    // Add table of contents
    text += '## Table of Contents\n\n';
    for (const section in data) {
      text += `- [${section}](#${createAnchor(section)})\n`;
      for (const lecture in data[section]) {
        text += `  - [${lecture}](#${createAnchor(lecture)})\n`;
      }
    }
    text += '\n---\n\n';
    
    // Add content
    for (const section in data) {
      text += `## ${section} {#${createAnchor(section)}}\n\n`;
      
      for (const lecture in data[section]) {
        text += `### ${lecture} {#${createAnchor(lecture)}}\n\n`;
        text += data[section][lecture].join('\n') + '\n\n';
      }
      
      text += '\n';
    }
    
    return text;
  }

  function createAnchor(text) {
    // Create an anchor from text (lowercase, replace spaces with hyphens, remove special chars)
    return text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
  }

  function downloadAsFile(content, filename) {
    const blob = new Blob([content], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}); 