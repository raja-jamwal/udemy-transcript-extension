document.addEventListener('DOMContentLoaded', function() {
  const startRecordingBtn = document.getElementById('start-recording');
  const stopRecordingBtn = document.getElementById('stop-recording');
  const downloadTranscriptsBtn = document.getElementById('download-transcripts');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const confirmYesBtn = document.getElementById('confirm-yes');
  const confirmNoBtn = document.getElementById('confirm-no');
  const mainControls = document.getElementById('main-controls');
  const statusDiv = document.getElementById('status');

  // Check if there's a recording in progress and saved transcript data
  chrome.runtime.sendMessage({action: 'getRecordingStatus'}, function(response) {
    if (response && response.isRecording) {
      startRecordingBtn.classList.add('hidden');
      stopRecordingBtn.classList.remove('hidden');
    } else {
      startRecordingBtn.classList.remove('hidden');
      stopRecordingBtn.classList.add('hidden');
    }
    
    // Check for transcript data
    chrome.storage.local.get(['transcriptData'], function(result) {
      if (result.transcriptData && Object.keys(result.transcriptData).length > 0) {
        downloadTranscriptsBtn.classList.remove('hidden');
      }
    });
  });

  // Start recording button clicked
  startRecordingBtn.addEventListener('click', function() {
    mainControls.classList.add('hidden');
    confirmationDialog.classList.remove('hidden');
  });

  // Stop recording button clicked
  stopRecordingBtn.addEventListener('click', function() {
    chrome.runtime.sendMessage({action: 'stopRecording'}, function(response) {
      if (response && response.success) {
        showStatus('Recording stopped successfully', 'success');
        startRecordingBtn.classList.remove('hidden');
        stopRecordingBtn.classList.add('hidden');
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
    chrome.storage.local.get(['transcriptData'], function(result) {
      if (result.transcriptData) {
        const transcriptText = formatTranscriptData(result.transcriptData);
        downloadAsFile(transcriptText, 'udemy_transcript.txt');
      } else {
        showStatus('No transcript data found', 'error');
      }
    });
  });

  function startRecording() {
    // Send message to the background script to start recording
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0].url.includes('udemy.com/course')) {
        chrome.runtime.sendMessage({action: 'startRecording', courseTab: tabs[0].id}, function(response) {
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
            showStatus('Failed to start recording', 'error');
            mainControls.classList.remove('hidden');
          }
        });
      } else {
        showStatus('Please navigate to a Udemy course page first', 'error');
        mainControls.classList.remove('hidden');
      }
    });
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = ''; // Clear existing classes
    statusDiv.classList.add(type);
    statusDiv.classList.remove('hidden');
  }

  function formatTranscriptData(data) {
    let text = '';
    
    for (const section in data) {
      text += `## ${section}\n\n`;
      
      for (const lecture in data[section]) {
        text += `### ${lecture}\n\n`;
        text += data[section][lecture].join('\n') + '\n\n';
      }
      
      text += '\n';
    }
    
    return text;
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