// Flag to track if we're in recording mode
let isRecordingTranscript = false;
let progressPanel = null;
let currentProgress = {
  currentSection: '',
  currentLecture: '',
  processedCount: 0,
  totalCount: 0
};

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getCourseStructure') {
    console.log('Received getCourseStructure request');
    
    // Find the div containing the course data payload
    const appLoaderDiv = document.querySelector('div[data-module-id="course-taking"]');
    if (!appLoaderDiv) {
      sendResponse({ success: false, error: 'Could not find the course data element on the page. Please ensure you are on a course lecture page.' });
      return true;
    }

    const moduleArgs = appLoaderDiv.getAttribute('data-module-args');
    let courseId = null;
    if (moduleArgs) {
        try {
            const data = JSON.parse(moduleArgs);
            courseId = data.courseId;
        } catch (e) {
            sendResponse({ success: false, error: 'Failed to parse course data from the page.' });
            return true;
        }
    }
    
    if (!courseId) {
        sendResponse({ success: false, error: 'Course ID not found in the page data.' });
        return true;
    }

    console.log('Found Course ID from page data:', courseId);

    // Create progress panel and respond
    createProgressPanel();
    updateProgressPanel('Fetching course curriculum...');
    
    sendResponse({ success: true, courseId: courseId });
    
    return true; // Keep the message channel open for async response
  }
  
  // NEW: Listener for progress updates from the background script
  else if (message.action === 'updateProgress') {
    currentProgress.currentSection = message.sectionTitle;
    currentProgress.currentLecture = message.lectureTitle;
    currentProgress.processedCount = message.processedCount;
    currentProgress.totalCount = message.totalCount;
    updateProgressPanel(`Recording: ${message.lectureTitle}`);
    sendResponse({ success: true });
    return true;
  }
  
  else if (message.action === 'recordingComplete') {
    // Update UI to show completed state
    const recordingStatus = document.getElementById('recording-status-badge');
    if (recordingStatus) {
      recordingStatus.textContent = '✓ Complete';
      recordingStatus.style.color = '#4caf50';
    }
    
    // Hide stop button, show close button
    const stopButton = progressPanel.querySelector('button');
    const closeButton = document.getElementById('close-button');
    if (stopButton && stopButton.textContent === 'Stop') {
      stopButton.style.display = 'none';
    }
    if (closeButton) {
      closeButton.style.display = 'block';
    }
    
    // Show download button
    const downloadContainer = document.getElementById('download-container');
    if (downloadContainer) {
      downloadContainer.style.display = 'block';
    }
    
    // Update status and simplify display
    updateProgressPanel('Recording complete! You can download the transcripts now.');
    
    // Hide detailed progress info
    const sectionInfo = document.getElementById('progress-section');
    const lectureInfo = document.getElementById('progress-lecture');
    if (sectionInfo) sectionInfo.style.display = 'none';
    if (lectureInfo) lectureInfo.style.display = 'none';
    
    showNotification('Transcript recording complete!');
    sendResponse({ success: true });
    return true;
  }
  
  else if (message.action === 'stopRecording') {
    stopRecording();
    sendResponse({ success: true });
    return true;
  }
});

// Create a progress panel
function createProgressPanel() {
  if (progressPanel) {
    document.body.removeChild(progressPanel);
  }
  
  progressPanel = document.createElement('div');
  progressPanel.id = 'udemy-transcript-progress';
  progressPanel.style.position = 'fixed';
  progressPanel.style.bottom = '20px';
  progressPanel.style.right = '20px';
  progressPanel.style.width = '400px';
  progressPanel.style.backgroundColor = 'white';
  progressPanel.style.borderRadius = '8px';
  progressPanel.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.2)';
  progressPanel.style.zIndex = '9999';
  progressPanel.style.padding = '15px';
  progressPanel.style.fontFamily = 'Arial, sans-serif';
  
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.marginBottom = '10px';
  
  const titleContainer = document.createElement('div');
  titleContainer.style.display = 'flex';
  titleContainer.style.alignItems = 'center';
  titleContainer.style.gap = '10px';
  
  const title = document.createElement('h3');
  title.textContent = 'Transcript Recorder';
  title.style.margin = '0';
  title.style.color = '#a435f0';
  
  const recordingStatus = document.createElement('span');
  recordingStatus.id = 'recording-status-badge';
  recordingStatus.textContent = '● Recording';
  recordingStatus.style.color = '#4caf50';
  recordingStatus.style.fontSize = '14px';
  
  titleContainer.appendChild(title);
  titleContainer.appendChild(recordingStatus);
  
  const buttonContainer = document.createElement('div');
  buttonContainer.style.display = 'flex';
  buttonContainer.style.gap = '10px';
  
  const stopButton = document.createElement('button');
  stopButton.textContent = 'Stop';
  stopButton.style.backgroundColor = '#e53935';
  stopButton.style.color = 'white';
  stopButton.style.border = 'none';
  stopButton.style.borderRadius = '4px';
  stopButton.style.padding = '5px 10px';
  stopButton.style.cursor = 'pointer';
  stopButton.onclick = stopRecording;
  
  const closeButton = document.createElement('button');
  closeButton.textContent = '✕';
  closeButton.style.backgroundColor = 'transparent';
  closeButton.style.color = '#757575';
  closeButton.style.border = 'none';
  closeButton.style.borderRadius = '4px';
  closeButton.style.padding = '5px 10px';
  closeButton.style.cursor = 'pointer';
  closeButton.style.display = 'none'; // Initially hidden
  closeButton.id = 'close-button';
  closeButton.onclick = removeProgressPanel;
  
  buttonContainer.appendChild(stopButton);
  buttonContainer.appendChild(closeButton);
  
  header.appendChild(titleContainer);
  header.appendChild(buttonContainer);
  
  const content = document.createElement('div');
  content.id = 'progress-content';
  
  const status = document.createElement('div');
  status.id = 'progress-status';
  status.style.marginBottom = '10px';
  status.textContent = 'Initializing...';
  
  const sectionInfo = document.createElement('div');
  sectionInfo.id = 'progress-section';
  sectionInfo.style.marginBottom = '5px';
  sectionInfo.style.fontWeight = 'bold';
  sectionInfo.textContent = 'Section: ';
  
  const lectureInfo = document.createElement('div');
  lectureInfo.id = 'progress-lecture';
  lectureInfo.style.marginBottom = '10px';
  lectureInfo.textContent = 'Lecture: ';
  
  const progressTextDiv = document.createElement('div');
  progressTextDiv.id = 'progress-text';
  progressTextDiv.style.display = 'flex';
  progressTextDiv.style.justifyContent = 'space-between';
  progressTextDiv.style.marginBottom = '5px';
  
  const progressCount = document.createElement('span');
  progressCount.id = 'progress-count';
  progressCount.textContent = '0/0 lectures processed';
  
  const progressPercent = document.createElement('span');
  progressPercent.id = 'progress-percent';
  progressPercent.textContent = '0%';
  
  progressTextDiv.appendChild(progressCount);
  progressTextDiv.appendChild(progressPercent);
  
  const progressBarContainer = document.createElement('div');
  progressBarContainer.style.width = '100%';
  progressBarContainer.style.backgroundColor = '#e0e0e0';
  progressBarContainer.style.height = '8px';
  progressBarContainer.style.borderRadius = '4px';
  progressBarContainer.style.overflow = 'hidden';
  
  const progressBar = document.createElement('div');
  progressBar.id = 'progress-bar';
  progressBar.style.width = '0%';
  progressBar.style.height = '100%';
  progressBar.style.backgroundColor = '#a435f0';
  progressBar.style.transition = 'width 0.3s';
  
  progressBarContainer.appendChild(progressBar);
  
  content.appendChild(status);
  content.appendChild(sectionInfo);
  content.appendChild(lectureInfo);
  content.appendChild(progressTextDiv);
  content.appendChild(progressBarContainer);
  
  // Add download button container (initially hidden)
  const downloadContainer = document.createElement('div');
  downloadContainer.id = 'download-container';
  downloadContainer.style.display = 'none';
  downloadContainer.style.marginTop = '15px';
  
  const downloadButton = document.createElement('button');
  downloadButton.textContent = 'Download Transcripts';
  downloadButton.style.backgroundColor = '#4caf50';
  downloadButton.style.color = 'white';
  downloadButton.style.border = 'none';
  downloadButton.style.borderRadius = '4px';
  downloadButton.style.padding = '8px 15px';
  downloadButton.style.cursor = 'pointer';
  downloadButton.style.width = '100%';
  downloadButton.onclick = downloadTranscripts;
  
  downloadContainer.appendChild(downloadButton);
  content.appendChild(downloadContainer);
  
  // Add attribution
  const attribution = document.createElement('div');
  attribution.style.textAlign = 'center';
  attribution.style.fontSize = '10px';
  attribution.style.color = '#757575';
  attribution.style.marginTop = '10px';
  attribution.innerHTML = '<a href="https://www.mypromind.com" target="_blank" style="color: #757575; text-decoration: none;">Brought to you by MyProMind.com</a>';
  content.appendChild(attribution);
  
  progressPanel.appendChild(header);
  progressPanel.appendChild(content);
  
  document.body.appendChild(progressPanel);
}

// Update the progress panel with current status
function updateProgressPanel(statusText) {
  if (!progressPanel) return;
  
  const statusElement = document.getElementById('progress-status');
  const sectionElement = document.getElementById('progress-section');
  const lectureElement = document.getElementById('progress-lecture');
  const countElement = document.getElementById('progress-count');
  const percentElement = document.getElementById('progress-percent');
  const barElement = document.getElementById('progress-bar');
  
  if (statusElement) statusElement.textContent = statusText;
  if (sectionElement) sectionElement.textContent = `Section: ${currentProgress.currentSection}`;
  if (lectureElement) lectureElement.textContent = `Lecture: ${currentProgress.currentLecture}`;
  
  if (countElement) {
    countElement.textContent = `${currentProgress.processedCount}/${currentProgress.totalCount} lectures processed`;
  }
  
  const percent = currentProgress.totalCount > 0 
    ? Math.round((currentProgress.processedCount / currentProgress.totalCount) * 100) 
    : 0;
  
  if (percentElement) percentElement.textContent = `${percent}%`;
  if (barElement) barElement.style.width = `${percent}%`;
}

// Remove the progress panel
function removeProgressPanel() {
  if (progressPanel && progressPanel.parentNode) {
    document.body.removeChild(progressPanel);
    progressPanel = null;
  }
}

// Stop the recording process
function stopRecording() {
  chrome.runtime.sendMessage({ action: 'stopRecording' }, (response) => {
    if (response && response.success) {
      showNotification('Transcript recording stopped.');
      
      // Update UI to show stopped state
      const recordingStatus = document.getElementById('recording-status-badge');
      if (recordingStatus) {
        recordingStatus.textContent = '◉ Stopped';
        recordingStatus.style.color = '#757575';
      }
      
      // Hide stop button, show close button
      const stopButton = progressPanel.querySelector('button');
      const closeButton = document.getElementById('close-button');
      if (stopButton && stopButton.textContent === 'Stop') {
        stopButton.style.display = 'none';
      }
      if (closeButton) {
        closeButton.style.display = 'block';
      }
      
      // Show download button
      const downloadContainer = document.getElementById('download-container');
      if (downloadContainer) {
        downloadContainer.style.display = 'block';
      }
      
      // Update status and simplify display
      updateProgressPanel('Recording stopped. You can download the transcripts now.');
      
      // Hide detailed progress info
      const sectionInfo = document.getElementById('progress-section');
      const lectureInfo = document.getElementById('progress-lecture');
      if (sectionInfo) sectionInfo.style.display = 'none';
      if (lectureInfo) lectureInfo.style.display = 'none';
    }
  });
}

// Download transcripts function
function downloadTranscripts() {
  chrome.storage.local.get(['transcriptData'], function(result) {
    if (chrome.runtime.lastError) {
      showNotification('Error accessing transcript data: ' + chrome.runtime.lastError.message);
      return;
    }
    
    if (result.transcriptData && Object.keys(result.transcriptData).length > 0) {
      // Format transcript data
      let transcriptText = '';
      for (const section in result.transcriptData) {
        transcriptText += `\n\n=== ${section} ===\n\n`;
        for (const lecture in result.transcriptData[section]) {
          transcriptText += `\n--- ${lecture} ---\n\n`;
          const transcript = result.transcriptData[section][lecture];
          transcriptText += transcript.join('\n') + '\n';
        }
      }
      
      // Create blob and download
      const blob = new Blob([transcriptText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'udemy_transcript.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showNotification('Transcript download started!');
    } else {
      showNotification('No transcript data available to download.');
    }
  });
}

// Show a notification to the user
function showNotification(message) {
  // Create the notification element
  const notification = document.createElement('div');
  notification.textContent = message;
  notification.style.position = 'fixed';
  notification.style.top = '20px';
  notification.style.right = '20px';
  notification.style.backgroundColor = '#a435f0';
  notification.style.color = 'white';
  notification.style.padding = '10px 15px';
  notification.style.borderRadius = '4px';
  notification.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
  notification.style.zIndex = '9999';
  notification.style.maxWidth = '300px';
  
  // Add to the page
  document.body.appendChild(notification);
  
  // Remove after 5 seconds
  setTimeout(() => {
    document.body.removeChild(notification);
  }, 5000);
}
