document.addEventListener('DOMContentLoaded', function() {
  const startRecordingBtn = document.getElementById('start-recording');
  const stopRecordingBtn = document.getElementById('stop-recording');
  const downloadTranscriptsBtn = document.getElementById('download-transcripts');
  const clearTranscriptsBtn = document.getElementById('clear-transcripts');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const downloadApiLogBtn = document.getElementById('download-api-log');
  const confirmYesBtn = document.getElementById('confirm-yes');
  const confirmNoBtn = document.getElementById('confirm-no');
  const mainControls = document.getElementById('main-controls');
  const statusDiv = document.getElementById('status');
  const languageSelect = document.getElementById('language-select');

  // Load and persist the user's preferred caption locale
  chrome.storage.local.get(['preferredLocale'], function(result) {
    if (result.preferredLocale) {
      languageSelect.value = result.preferredLocale;
    }
  });
  languageSelect.addEventListener('change', function() {
    chrome.storage.local.set({ preferredLocale: languageSelect.value });
  });

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
        showStatus('Recording in progress...', 'info');
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
    chrome.storage.local.get(null, function(result) {
      if (chrome.runtime.lastError) {
        console.error('Error accessing storage:', chrome.runtime.lastError);
        return;
      }

      const hasTranscripts = Object.keys(result).some(key => key.startsWith('transcriptData_'));
      const hasApiRecordings = Object.keys(result).some(key => key.startsWith('apiRecording_'));

      if (hasTranscripts) {
        downloadTranscriptsBtn.classList.remove('hidden');
        clearTranscriptsBtn.classList.remove('hidden');

        // Debug info
        for (const key of Object.keys(result)) {
          if (key.startsWith('transcriptData_')) {
            const courseId = key.replace('transcriptData_', '');
            const data = result[key];
            let sectionCount = Object.keys(data).length;
            let lectureCount = 0;
            for (const section in data) {
              lectureCount += Object.keys(data[section]).length;
            }
            console.log(`Course ${courseId}: ${sectionCount} sections with ${lectureCount} lectures`);
          }
        }
      } else {
        downloadTranscriptsBtn.classList.add('hidden');
        clearTranscriptsBtn.classList.add('hidden');
      }

      if (hasApiRecordings) {
        downloadApiLogBtn.classList.remove('hidden');
      } else {
        downloadApiLogBtn.classList.add('hidden');
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
    chrome.storage.local.get(null, function(result) {
      if (chrome.runtime.lastError) {
        showStatus('Error accessing storage: ' + chrome.runtime.lastError.message, 'error');
        return;
      }

      let downloadCount = 0;
      for (const key of Object.keys(result)) {
        if (key.startsWith('transcriptData_') && Object.keys(result[key]).length > 0) {
          const courseId = key.replace('transcriptData_', '');
          const transcriptText = formatTranscriptData(result[key], 'Udemy Course Transcript');
          downloadAsFile(transcriptText, `udemy_transcript_${courseId}.txt`);
          downloadCount++;
        }
      }

      if (downloadCount > 0) {
        showStatus('Download started!', 'success');
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
          downloadApiLogBtn.classList.add('hidden');
        } else {
          showStatus('Failed to clear transcript data', 'error');
        }
      });
    }
  });

  // Download API log
  downloadApiLogBtn.addEventListener('click', function() {
    showStatus('Preparing API log download...', 'info');
    chrome.runtime.sendMessage({action: 'getApiRecording'}, function(response) {
      if (chrome.runtime.lastError) {
        showStatus('Error accessing API log: ' + chrome.runtime.lastError.message, 'error');
        return;
      }

      if (response && response.success && response.data) {
        let downloadCount = 0;
        for (const key of Object.keys(response.data)) {
          const recording = response.data[key];
          if (recording && recording.requests && recording.requests.length > 0) {
            const courseId = key.replace('apiRecording_', '');
            const json = JSON.stringify(recording, null, 2);
            const blob = new Blob([json], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `api_recording_${courseId}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            downloadCount++;
          }
        }
        if (downloadCount > 0) {
          showStatus('Download started!', 'success');
          setTimeout(() => { statusDiv.classList.add('hidden'); }, 3000);
        } else {
          showStatus('No API recording data found', 'error');
        }
      } else {
        showStatus('No API recording data found', 'error');
      }
    });
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