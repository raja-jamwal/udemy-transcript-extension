// Flag to track if we're in recording mode
let isRecordingTranscript = false;
let progressPanel = null;
let currentProgress = {
  currentSection: '',
  currentLecture: '',
  processedCount: 0,
  totalCount: 0
};
let retryCount = 0;
const MAX_RETRIES = 3;

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getCourseStructure') {
    console.log('Received getCourseStructure request');
    
    // Check if we're on a course page
    if (!window.location.href.includes('/course/') && !window.location.href.includes('/learn/')) {
      console.error('Not on a Udemy course page');
      sendResponse({ success: false, error: 'Not on a Udemy course page. Please navigate to a Udemy course.' });
      return true;
    }
    
    // Extract course structure from the sidebar
    extractCourseStructure()
      .then(courseData => {
        // Calculate total lectures
        const totalLectures = courseData.reduce((total, section) => total + section.lectures.length, 0);
        currentProgress.totalCount = totalLectures;
        
        // Create progress panel
        createProgressPanel();
        updateProgressPanel('Initializing...');
        
        // Debug log the course structure
        console.log('Course structure extracted:', courseData);
        console.log(`Found ${courseData.length} sections with a total of ${totalLectures} lectures`);
        
        sendResponse({ success: true, courseData });
      })
      .catch(error => {
        console.error('Error extracting course structure:', error);
        console.log('DOM at time of error:', document.body.innerHTML.substring(0, 500) + '...');
        
        // Try alternative extraction method
        console.log('Attempting alternative extraction method...');
        extractCourseStructureAlternative()
          .then(courseData => {
            if (courseData && courseData.length > 0) {
              console.log('Alternative extraction successful!');
              const totalLectures = courseData.reduce((total, section) => total + section.lectures.length, 0);
              currentProgress.totalCount = totalLectures;
              createProgressPanel();
              sendResponse({ success: true, courseData });
            } else {
              sendResponse({ 
                success: false, 
                error: `Failed to extract course structure: ${error.message}. Please try refreshing the page.`
              });
            }
          })
          .catch(altError => {
            console.error('Alternative extraction also failed:', altError);
            sendResponse({ 
              success: false, 
              error: `Failed to extract course structure: ${error.message}. Alternative method also failed: ${altError.message}`
            });
          });
      });
    
    return true; // Keep the message channel open for async response
  }
  
  else if (message.action === 'navigateToLecture') {
    // Update progress information
    currentProgress.processedCount++;
    
    // Reset retry count for each new lecture
    retryCount = 0;
    
    // Navigate to the specified lecture
    navigateToLecture(message.sectionIndex, message.lectureIndex)
      .then(({ sectionTitle, lectureTitle }) => {
        currentProgress.currentSection = sectionTitle;
        currentProgress.currentLecture = lectureTitle;
        
        // Update progress panel
        updateProgressPanel('Recording transcript...');
        
        isRecordingTranscript = true;
        // Wait for page to load and then extract transcript
        setTimeout(() => {
          extractTranscript()
            .then(({ sectionTitle, lectureTitle, transcript }) => {
              // Send transcript data back to background script
              chrome.runtime.sendMessage({
                action: 'transcriptCaptured',
                sectionTitle,
                lectureTitle,
                transcript
              });
              isRecordingTranscript = false;
            })
            .catch(error => {
              console.error('Error extracting transcript:', error);
              isRecordingTranscript = false;
              updateProgressPanel('Error extracting transcript, moving to next lecture...');
              
              // Continue to next lecture even if transcript extraction fails
              chrome.runtime.sendMessage({
                action: 'transcriptCaptured',
                sectionTitle: currentProgress.currentSection,
                lectureTitle: currentProgress.currentLecture,
                transcript: [`[Could not extract transcript: ${error.message}]`]
              });
            });
        }, 8000); // Increase wait time to 8 seconds for page to fully load
        
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Error navigating to lecture:', error);
        updateProgressPanel(`Error navigating to lecture: ${error.message}`);
        
        // Try again if under max retries
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          updateProgressPanel(`Retrying... (${retryCount}/${MAX_RETRIES})`);
          
          // Wait and retry
          setTimeout(() => {
            navigateToLecture(message.sectionIndex, message.lectureIndex)
              .then(({ sectionTitle, lectureTitle }) => {
                // Continue with normal process
                // (similar code as above, but simplified for retry)
                extractTranscript()
                  .then(({ transcript }) => {
                    chrome.runtime.sendMessage({
                      action: 'transcriptCaptured',
                      sectionTitle,
                      lectureTitle,
                      transcript
                    });
                  })
                  .catch(err => {
                    // Skip this lecture if extraction fails on retry
                    chrome.runtime.sendMessage({
                      action: 'transcriptCaptured',
                      sectionTitle,
                      lectureTitle,
                      transcript: [`[Transcript extraction failed after retry: ${err.message}]`]
                    });
                  });
              })
              .catch(retryError => {
                // If retry also fails, send error and move to next lecture
                console.error('Retry failed:', retryError);
                chrome.runtime.sendMessage({
                  action: 'transcriptCaptured',
                  sectionTitle: `Section ${message.sectionIndex + 1}`,
                  lectureTitle: `Lecture ${message.lectureIndex + 1}`,
                  transcript: [`[Navigation failed after retry: ${retryError.message}]`]
                });
              });
          }, 5000);
        } else {
          // Skip this lecture after max retries
          chrome.runtime.sendMessage({
            action: 'transcriptCaptured',
            sectionTitle: `Section ${message.sectionIndex + 1}`,
            lectureTitle: `Lecture ${message.lectureIndex + 1}`,
            transcript: [`[Navigation failed after ${MAX_RETRIES} retries: ${error.message}]`]
          });
        }
        
        sendResponse({ success: false, error: error.message });
      });
    
    return true;
  }
  
  else if (message.action === 'recordingComplete') {
    removeProgressPanel();
    showNotification('Transcript recording complete! Click the extension icon to download.');
    sendResponse({ success: true });
    return true;
  }
  
  else if (message.action === 'stopRecording') {
    stopRecording();
    sendResponse({ success: true });
    return true;
  }
});

// Extract course structure from the sidebar
async function extractCourseStructure() {
  console.log('Starting course structure extraction...');
  
  // Check if we're on a course page
  if (!window.location.href.includes('/course/') && !window.location.href.includes('/learn/')) {
    throw new Error('Not on a Udemy course page');
  }
  
  // Debug current page
  console.log('Current URL:', window.location.href);
  console.log('Page title:', document.title);
  
  try {
    // Wait for the sidebar to be visible with increased timeout
    console.log('Waiting for sidebar...');
    await waitForElement('[data-purpose="sidebar"], .ud-component--course-taking--curriculum-sidebar', 30000);
    console.log('Sidebar found!');
    
    // Ensure the sidebar is properly loaded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get sections with better selector options
    console.log('Looking for course sections...');
    const sections = document.querySelectorAll(
      '[data-purpose^="section-panel-"], ' +
      '.ud-accordion-panel, ' +
      '[data-purpose="curriculum-section"]'
    );
    
    if (!sections || sections.length === 0) {
      console.error('No sections found with primary selectors');
      // Try a different approach - look for any section-like elements
      const possibleSections = document.querySelectorAll('div[id^="section-"]');
      if (possibleSections && possibleSections.length > 0) {
        console.log('Found alternative sections:', possibleSections.length);
      } else {
        throw new Error('No course sections found. The page structure may have changed.');
      }
    }
    
    console.log(`Found ${sections.length} course sections`);
    
    // Try to expand all sections first
    for (const section of sections) {
      try {
        const toggleBtn = section.querySelector(
          'button.js-panel-toggler, ' +
          '[aria-expanded], ' +
          '.ud-accordion-panel-toggler'
        );
        
        if (!toggleBtn) {
          console.log('No toggle button found for a section, may already be expanded');
          continue;
        }
        
        const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        
        if (!isExpanded) {
          console.log('Expanding a collapsed section...');
          toggleBtn.click();
          // Wait a bit for the animation to complete
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        console.warn('Error expanding section:', err);
        // Continue with other sections
      }
    }
    
    // Wait additional time for all sections to expand
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Now extract the data
    const courseData = [];
    
    // Debug what we're working with
    console.log('Section elements found:', sections.length);
    if (sections.length > 0) {
      console.log('First section HTML structure:', sections[0].outerHTML.substring(0, 500) + '...');
    }
    
    for (const section of sections) {
      try {
        // Try multiple selectors for the section title
        const sectionTitle = 
          section.querySelector('h3 .ud-accordion-panel-title')?.innerText.trim() ||
          section.querySelector('[data-purpose="section-title"]')?.innerText.trim() ||
          section.querySelector('h3')?.innerText.trim() ||
          section.querySelector('.section-title')?.innerText.trim() ||
          `Section ${courseData.length + 1}`;
        
        // Skip sections without a title (should not happen now with fallback)
        if (!sectionTitle) {
          console.warn('Found a section without a title, using index as fallback');
        }
        
        // Try multiple selectors for lectures
        const lectures = Array.from(
          section.querySelectorAll(
            '[data-purpose^="curriculum-item-"], ' +
            '.ud-block-list-item, ' +
            '.curriculum-item-link'
          )
        );
        
        console.log(`Section "${sectionTitle}" has ${lectures.length} items`);
        
        if (lectures.length === 0) {
          console.warn(`No lectures found in section "${sectionTitle}" - may be a formatting issue`);
        }
        
        const lectureData = lectures.map(lecture => {
          try {
            const title = 
              lecture.querySelector('[data-purpose="item-title"]')?.innerText.trim() ||
              lecture.querySelector('.ud-block-list-item-content')?.innerText.trim() ||
              lecture.querySelector('.item-title')?.innerText.trim() ||
              'Untitled Lecture';
            
            const duration = 
              lecture.querySelector('.curriculum-item-link--metadata--XK804 span')?.innerText.trim() ||
              lecture.querySelector('[data-purpose="item-content-summary"]')?.innerText.trim() ||
              '';
            
            // Check if this is a video lecture (has a play button or video indicator)
            const isVideo = 
              !!lecture.querySelector('button[aria-label^="Play"]') ||
              !!lecture.querySelector('[data-purpose="play-button"]') ||
              !!lecture.querySelector('.udi-play') ||
              lecture.textContent.includes('Video') ||
              lecture.textContent.includes('video');
            
            return { title: title || 'Untitled Lecture', duration, isVideo };
          } catch (err) {
            console.warn('Error processing a lecture item:', err);
            return { title: 'Error Lecture', duration: '', isVideo: false };
          }
        });
        
        // Only include video lectures
        const videoLectures = lectureData.filter(lecture => lecture.isVideo);
        console.log(`Section "${sectionTitle}" has ${videoLectures.length} video lectures`);
        
        if (videoLectures.length > 0) {
          courseData.push({
            section: sectionTitle,
            lectures: videoLectures
          });
        } else {
          console.warn(`No video lectures found in section "${sectionTitle}"`);
        }
      } catch (err) {
        console.warn('Error processing a section:', err);
        // Continue with other sections
      }
    }
    
    if (courseData.length === 0) {
      throw new Error('No course sections with video lectures found. Please make sure you are on a course content page.');
    }
    
    return courseData;
  } catch (error) {
    console.error('Error in extractCourseStructure:', error);
    throw error;
  }
}

// Alternative method to extract course structure as a fallback
async function extractCourseStructureAlternative() {
  console.log('Using alternative extraction method...');
  
  try {
    // Wait for any content to be loaded
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Look for any structured content that could be sections
    const possibleSections = Array.from(document.querySelectorAll('div[class*="section"], div[class*="chapter"], div[id*="section"], div[id*="chapter"]'));
    console.log('Alternative method found potential sections:', possibleSections.length);
    
    if (possibleSections.length === 0) {
      throw new Error('No sections found with alternative method');
    }
    
    const courseData = [];
    let sectionCounter = 1;
    
    for (const section of possibleSections) {
      const sectionTitle = 
        section.querySelector('h1, h2, h3, h4, h5, .title, [class*="title"]')?.innerText.trim() ||
        `Section ${sectionCounter++}`;
      
      // Look for any elements that might be lecture items
      const possibleLectures = Array.from(section.querySelectorAll('li, div[class*="item"], div[class*="lecture"], a[href*="lecture"]'));
      
      // Filter to likely video lectures (has play icon, mentions video, etc.)
      const videoLectures = possibleLectures
        .filter(item => {
          const hasPlayIcon = !!item.querySelector('svg, i[class*="play"], span[class*="play"]');
          const mentionsVideo = item.textContent.toLowerCase().includes('video');
          const hasTime = /\d+:\d+/.test(item.textContent); // Looks for time format like 5:23
          
          return hasPlayIcon || mentionsVideo || hasTime;
        })
        .map(lecture => {
          const title = lecture.textContent.split('\n')[0].trim() || 'Untitled Lecture';
          return { title, duration: '', isVideo: true };
        });
      
      if (videoLectures.length > 0) {
        courseData.push({
          section: sectionTitle,
          lectures: videoLectures
        });
      }
    }
    
    return courseData;
  } catch (error) {
    console.error('Error in alternative extraction:', error);
    throw error;
  }
}

// Navigate to a specific lecture
async function navigateToLecture(sectionIndex, lectureIndex) {
  // Wait for the sidebar to be visible with increased timeout
  await waitForElement('[data-purpose="sidebar"]', 30000);
  
  // Get all sections
  const sections = document.querySelectorAll('[data-purpose^="section-panel-"]');
  
  if (sections.length === 0) {
    throw new Error('No course sections found');
  }
  
  if (sectionIndex >= sections.length) {
    throw new Error(`Section index ${sectionIndex} out of bounds (total: ${sections.length})`);
  }
  
  const section = sections[sectionIndex];
  const sectionTitle = section.querySelector('h3 .ud-accordion-panel-title')?.innerText.trim() || `Section ${sectionIndex + 1}`;
  
  // Make sure the section is expanded
  const toggleBtn = section.querySelector('button.js-panel-toggler, [aria-expanded]');
  const isExpanded = toggleBtn?.getAttribute('aria-expanded') === 'true';
  
  if (!isExpanded) {
    toggleBtn?.click();
    // Wait for the animation to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Get all video lectures in this section
  const lectures = Array.from(section.querySelectorAll('[data-purpose^="curriculum-item-"]'))
    .filter(lecture => !!lecture.querySelector('button[aria-label^="Play"]'));
  
  if (lectures.length === 0) {
    throw new Error(`No video lectures found in section ${sectionIndex + 1}`);
  }
  
  if (lectureIndex >= lectures.length) {
    throw new Error(`Lecture index ${lectureIndex} out of bounds (total: ${lectures.length})`);
  }
  
  // Get lecture title
  const lectureElement = lectures[lectureIndex];
  const lectureTitle = lectureElement.querySelector('[data-purpose="item-title"]')?.innerText.trim() || `Lecture ${lectureIndex + 1}`;
  
  // Click on the lecture to navigate to it
  const playButton = lectureElement.querySelector('button[aria-label^="Play"]');
  if (!playButton) {
    throw new Error('Play button not found for lecture');
  }
  
  // Click to navigate
  playButton.click();
  
  // Wait for the page to navigate and load
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  return { sectionTitle, lectureTitle };
}

// Extract transcript from the current lecture
async function extractTranscript() {
  // First, get the current section and lecture titles from the page
  const sectionTitle = document.querySelector('.ud-heading-sm[data-purpose="section-title"]')?.innerText.trim() 
    || currentProgress.currentSection 
    || 'Unknown Section';
  
  const lectureTitle = document.querySelector('.ud-heading-xxl[data-purpose="lecture-title"]')?.innerText.trim() 
    || currentProgress.currentLecture 
    || 'Unknown Lecture';
  
  try {
    // Open the transcript panel if it's not already open
    await openTranscriptPanel();
    
    // Wait for transcript content to be available
    await waitForElement('[data-purpose="cue-text"]', 15000);
    
    // Extract the transcript text
    const transcriptElements = document.querySelectorAll('[data-purpose="cue-text"]');
    
    if (transcriptElements.length === 0) {
      return { 
        sectionTitle, 
        lectureTitle, 
        transcript: ['[No transcript available for this lecture]'] 
      };
    }
    
    const transcript = Array.from(transcriptElements).map(el => el.innerText.trim());
    
    // Return the transcript data
    return { sectionTitle, lectureTitle, transcript };
  } catch (error) {
    console.error('Error extracting transcript:', error);
    
    // If transcript can't be found, return an empty transcript
    return { 
      sectionTitle, 
      lectureTitle, 
      transcript: [`[Could not extract transcript: ${error.message}]`] 
    };
  }
}

// Open the transcript panel if it's not already open
async function openTranscriptPanel() {
  try {
    const transcriptButton = await waitForElement('button[data-purpose="transcript-toggle"]', 10000);
    
    // Check if transcript is already expanded
    const isExpanded = transcriptButton.getAttribute('aria-expanded') === 'true';
    
    if (!isExpanded) {
      // Click to expand
      transcriptButton.click();
      
      // Wait for the panel to open
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    // If transcript button isn't found, the video might not have a transcript
    console.warn('Transcript button not found:', error);
    throw new Error('No transcript available for this lecture');
  }
}

// Helper function to wait for an element to be available in the DOM with exponential backoff
function waitForElement(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let interval = 100;
    const maxInterval = 1000;
    
    function checkElement() {
      const element = document.querySelector(selector);
      
      if (element) {
        resolve(element);
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timed out waiting for element: ${selector}`));
      } else {
        // Exponential backoff
        interval = Math.min(interval * 1.5, maxInterval);
        setTimeout(checkElement, interval);
      }
    }
    
    checkElement();
  });
}

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
  progressPanel.style.width = '300px';
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
  
  const title = document.createElement('h3');
  title.textContent = 'Transcript Recorder';
  title.style.margin = '0';
  title.style.color = '#a435f0';
  
  const stopButton = document.createElement('button');
  stopButton.textContent = 'Stop';
  stopButton.style.backgroundColor = '#e53935';
  stopButton.style.color = 'white';
  stopButton.style.border = 'none';
  stopButton.style.borderRadius = '4px';
  stopButton.style.padding = '5px 10px';
  stopButton.style.cursor = 'pointer';
  stopButton.onclick = stopRecording;
  
  header.appendChild(title);
  header.appendChild(stopButton);
  
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
      showNotification('Transcript recording stopped by user.');
      removeProgressPanel();
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