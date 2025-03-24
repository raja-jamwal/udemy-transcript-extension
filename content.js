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
              }, (response) => {
                // Check if message was sent successfully
                if (chrome.runtime.lastError) {
                  console.error('Error sending transcript:', chrome.runtime.lastError);
                  // Force continue to next lecture after error
                  forceNextLecture(sectionTitle, lectureTitle, 
                    `[Error sending transcript: ${chrome.runtime.lastError.message}]`);
                }
                isRecordingTranscript = false;
              });
            })
            .catch(error => {
              console.error('Error extracting transcript:', error);
              isRecordingTranscript = false;
              updateProgressPanel('Error extracting transcript, moving to next lecture...');
              
              // Continue to next lecture even if transcript extraction fails
              forceNextLecture(currentProgress.currentSection, currentProgress.currentLecture, 
                `[Could not extract transcript: ${error.message}]`);
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
                    }, (response) => {
                      // Check for errors in response
                      if (chrome.runtime.lastError) {
                        forceNextLecture(sectionTitle, lectureTitle, 
                          `[Error sending transcript on retry: ${chrome.runtime.lastError.message}]`);
                      }
                    });
                  })
                  .catch(err => {
                    // Skip this lecture if extraction fails on retry
                    forceNextLecture(sectionTitle, lectureTitle, 
                      `[Transcript extraction failed after retry: ${err.message}]`);
                  });
              })
              .catch(retryError => {
                // If retry also fails, send error and move to next lecture
                console.error('Retry failed:', retryError);
                const sectionName = `Section ${message.sectionIndex + 1}`;
                const lectureName = `Lecture ${message.lectureIndex + 1}`;
                forceNextLecture(sectionName, lectureName, 
                  `[Navigation failed after retry: ${retryError.message}]`);
              });
          }, 5000);
        } else {
          // Skip this lecture after max retries
          const sectionName = `Section ${message.sectionIndex + 1}`;
          const lectureName = `Lecture ${message.lectureIndex + 1}`;
          forceNextLecture(sectionName, lectureName, 
            `[Navigation failed after ${MAX_RETRIES} retries: ${error.message}]`);
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

  // Add a new handler for checking content script health
  if (message.action === 'pingContentScript') {
    sendResponse({ alive: true });
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
    
    // Try to expand all sections first - this is critical
    console.log('Expanding all course sections...');
    const expandButtons = document.querySelectorAll(
      '[data-purpose="expand-all"], ' + 
      'button[aria-label="Expand all sections"], ' +
      'button.ud-btn-ghost[aria-label*="all sections"]'
    );
    
    // If we find an expand all button, click it
    if (expandButtons && expandButtons.length > 0) {
      console.log('Found "Expand All" button, clicking it...');
      expandButtons[0].click();
      // Wait for all sections to expand
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      console.log('No "Expand All" button found, will expand sections manually');
    }
    
    // Get sections with better selector options - use multiple selectors for different Udemy UI versions
    console.log('Looking for course sections...');
    const sections = document.querySelectorAll(
      '[data-purpose^="section-panel-"], ' +
      '.ud-accordion-panel, ' +
      '[data-purpose="curriculum-section"], ' +
      'div[data-purpose="section-container"], ' +
      '.curriculum-item-container'
    );
    
    if (!sections || sections.length === 0) {
      console.error('No sections found with primary selectors');
      // Try a different approach - look for any section-like elements
      const possibleSections = document.querySelectorAll(
        'div[id^="section-"], ' +
        'div[class*="section--"], ' + 
        'div[class*="chapter--"], ' +
        '[data-purpose*="section"]'
      );
      
      if (possibleSections && possibleSections.length > 0) {
        console.log('Found alternative sections:', possibleSections.length);
        
        // Try to use these alternative sections
        return processAlternativeSections(possibleSections);
      } else {
        throw new Error('No course sections found. The page structure may have changed.');
      }
    }
    
    console.log(`Found ${sections.length} course sections`);
    
    // Try to expand all sections manually as a backup
    for (const section of sections) {
      try {
        const toggleBtn = section.querySelector(
          'button.js-panel-toggler, ' +
          '[aria-expanded], ' +
          '.ud-accordion-panel-toggler, ' + 
          'button[aria-label*="Expand"], ' +
          'button[data-purpose*="toggle"]'
        );
        
        if (!toggleBtn) {
          console.log('No toggle button found for a section, may already be expanded');
          continue;
        }
        
        const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        
        if (!isExpanded) {
          console.log('Expanding a collapsed section...');
          toggleBtn.click();
          // Wait for the animation to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (err) {
        console.warn('Error expanding section:', err);
        // Continue with other sections
      }
    }
    
    // Wait additional time for all sections to expand
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // DEBUG: Log all the section titles we found to help diagnose issues
    console.log('Section titles found:');
    for (const section of sections) {
      try {
        const sectionTitle = 
          section.querySelector('h3 .ud-accordion-panel-title')?.innerText.trim() ||
          section.querySelector('[data-purpose="section-title"]')?.innerText.trim() ||
          section.querySelector('h3')?.innerText.trim() ||
          section.querySelector('.section-title')?.innerText.trim() ||
          'Unknown Section';
        console.log(` - ${sectionTitle}`);
      } catch (err) {
        console.log(' - [Error getting section title]');
      }
    }
    
    // Now extract the data with improved selectors
    const courseData = [];
    
    // Debug what we're working with
    console.log('Section elements found:', sections.length);
    if (sections.length > 0) {
      console.log('First section HTML structure:', sections[0].outerHTML.substring(0, 500) + '...');
    }
    
    for (const section of sections) {
      try {
        // Try multiple selectors for the section title with better fallbacks
        const sectionTitle = 
          section.querySelector('h3 .ud-accordion-panel-title')?.innerText.trim() ||
          section.querySelector('[data-purpose="section-title"]')?.innerText.trim() ||
          section.querySelector('h3')?.innerText.trim() ||
          section.querySelector('button[data-purpose*="toggle"]')?.innerText.trim() || 
          section.querySelector('.section-title')?.innerText.trim() ||
          section.querySelector('[class*="title"]')?.innerText.trim() ||
          `Section ${courseData.length + 1}`;
        
        // Handle duplicate section titles by appending a number
        let finalSectionTitle = sectionTitle;
        let dupCounter = 1;
        while (courseData.some(s => s.section === finalSectionTitle)) {
          finalSectionTitle = `${sectionTitle} (${dupCounter++})`;
        }
        
        // Try multiple selectors for lectures with more fallbacks
        let lectures = Array.from(
          section.querySelectorAll(
            '[data-purpose^="curriculum-item-"], ' +
            '.ud-block-list-item, ' +
            '.curriculum-item-link, ' +
            'div[class*="item--"], ' +
            '[data-purpose*="lecture"], ' +
            '[id^="lecture-"]'
          )
        );
        
        console.log(`Section "${finalSectionTitle}" has ${lectures.length} items`);
        
        // If we got nothing, try a more aggressive approach
        if (lectures.length === 0) {
          console.warn(`No lectures found in section "${finalSectionTitle}" - trying alternative selectors`);
          
          // Look for anything that might be a lecture
          lectures = Array.from(
            section.querySelectorAll('li, [class*="lecture"], [class*="lesson"], a[href*="lecture"]')
          );
          
          console.log(`Alternative selectors found ${lectures.length} potential lectures`);
        }
        
        if (lectures.length === 0) {
          console.warn(`No lectures found in section "${finalSectionTitle}" - may be a formatting issue`);
        }
        
        const lectureData = lectures.map(lecture => {
          try {
            // Title with much more fallback options
            const title = 
              lecture.querySelector('[data-purpose="item-title"]')?.innerText.trim() ||
              lecture.querySelector('[data-purpose^="title"]')?.innerText.trim() ||
              lecture.querySelector('.ud-block-list-item-content')?.innerText.trim() ||
              lecture.querySelector('.item-title')?.innerText.trim() ||
              lecture.querySelector('span[class*="title"]')?.innerText.trim() ||
              lecture.querySelector('a')?.innerText.trim() ||
              lecture.innerText.trim().split('\n')[0] ||
              'Untitled Lecture';
            
            // Extract duration with more fallbacks
            const duration = 
              lecture.querySelector('.curriculum-item-link--metadata--XK804 span')?.innerText.trim() ||
              lecture.querySelector('[data-purpose="item-content-summary"]')?.innerText.trim() ||
              lecture.querySelector('[data-purpose*="duration"]')?.innerText.trim() ||
              lecture.querySelector('span[class*="duration"]')?.innerText.trim() ||
              Array.from(lecture.querySelectorAll('span'))
                .find(span => /^\d+:\d+$/.test(span.innerText.trim()))?.innerText.trim() ||
              '';
            
            // Enhanced video detection
            const isVideo = 
              !!lecture.querySelector('button[aria-label^="Play"]') ||
              !!lecture.querySelector('[data-purpose="play-button"]') ||
              !!lecture.querySelector('.udi-play') ||
              !!lecture.querySelector('svg[class*="play"]') ||
              !!lecture.querySelector('i[class*="play"]') ||
              !!lecture.querySelector('img[alt*="Video"]') ||
              lecture.textContent.includes('Video') ||
              lecture.textContent.includes('video') ||
              // Duration pattern is a good indicator of video content
              /^\d+:\d+$/.test(duration);
            
            return { 
              title: title || 'Untitled Lecture', 
              duration, 
              isVideo,
              element: lecture // Keep reference to the DOM element for later
            };
          } catch (err) {
            console.warn('Error processing a lecture item:', err);
            return { title: 'Error Lecture', duration: '', isVideo: false, element: lecture };
          }
        });
        
        // Consider all items as potential videos if we can't detect specifically
        let videoLectures = lectureData.filter(lecture => lecture.isVideo);
        
        // If no videos detected, but we have items with duration, treat them as videos
        if (videoLectures.length === 0 && lectureData.some(l => l.duration)) {
          console.log(`No videos detected in "${finalSectionTitle}" but found items with duration - treating as videos`);
          videoLectures = lectureData.filter(l => l.duration);
        }
        
        // Last resort - if still nothing, include all items that look like content
        if (videoLectures.length === 0 && lectures.length > 0) {
          console.log(`No clear videos in "${finalSectionTitle}" - including all items as potential content`);
          videoLectures = lectureData.filter(l => 
            !l.title.toLowerCase().includes('quiz') && 
            !l.title.toLowerCase().includes('exercise') && 
            !l.title.toLowerCase().includes('assignment')
          );
        }
        
        console.log(`Section "${finalSectionTitle}" has ${videoLectures.length} video lectures`);
        
        // Only include sections with lectures to avoid empty sections
        if (videoLectures.length > 0) {
          // Remove element references before storing
          const cleanLectures = videoLectures.map(({ title, duration, isVideo }) => ({ title, duration, isVideo }));
          
          courseData.push({
            section: finalSectionTitle,
            lectures: cleanLectures,
            originalElements: videoLectures // Keep for debugging/navigation
          });
        } else {
          console.warn(`No video lectures found in section "${finalSectionTitle}"`);
        }
      } catch (err) {
        console.warn('Error processing a section:', err);
        // Continue with other sections
      }
    }
    
    // Log counts and validate
    console.log(`Finished processing course structure. Found ${courseData.length} sections with content.`);
    let totalLectures = 0;
    for (const section of courseData) {
      totalLectures += section.lectures.length;
      console.log(`- ${section.section}: ${section.lectures.length} lectures`);
    }
    console.log(`Total lectures to process: ${totalLectures}`);
    
    if (courseData.length === 0) {
      throw new Error('No course sections with video lectures found. Please make sure you are on a course content page.');
    }
    
    return courseData;
  } catch (error) {
    console.error('Error in extractCourseStructure:', error);
    throw error;
  }
}

// Process alternative section elements when standard selectors fail
async function processAlternativeSections(sections) {
  console.log('Processing alternative sections...');
  
  const courseData = [];
  let sectionCounter = 1;
  
  // Try to expand all possible sections first
  for (const section of sections) {
    try {
      const toggles = section.querySelectorAll('button, [aria-expanded], [data-purpose*="toggle"]');
      for (const toggle of toggles) {
        if (toggle.getAttribute('aria-expanded') === 'false') {
          console.log('Expanding alternative section...');
          toggle.click();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch (err) {
      console.warn('Error expanding alternative section:', err);
    }
  }
  
  // Wait for expansions to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Process each section
  for (const section of sections) {
    try {
      // Try to get section title with many fallbacks
      const sectionTitle = 
        section.querySelector('h1, h2, h3, h4, h5')?.innerText.trim() ||
        section.querySelector('.title, [class*="title"]')?.innerText.trim() ||
        section.querySelector('button[aria-expanded]')?.innerText.trim() ||
        `Section ${sectionCounter++}`;
      
      // Look for any elements that might be lecture items with more aggressive selectors
      const possibleLectures = Array.from(
        section.querySelectorAll(
          'li, ' + 
          'div[class*="item"], ' + 
          'div[class*="lecture"], ' + 
          'a[href*="lecture"], ' +
          '[data-purpose*="item"], ' +
          '[class*="lesson"], ' +
          '.ud-block-list-item'
        )
      );
      
      console.log(`Alternative section "${sectionTitle}" has ${possibleLectures.length} potential lectures`);
      
      // Filter to likely video lectures with much more forgiving criteria
      const videoLectures = possibleLectures
        .filter(item => {
          // Various indicators that this might be a video
          const hasPlayIcon = !!item.querySelector('svg, i[class*="play"], span[class*="play"]');
          const mentionsVideo = item.textContent.toLowerCase().includes('video');
          const hasTime = /\d+:\d+/.test(item.textContent); // Looks for time format like 5:23
          const hasVideoElement = !!item.querySelector('video');
          const hasVideoClass = item.className.toLowerCase().includes('video');
          const isNotQuiz = !item.textContent.toLowerCase().includes('quiz');
          const isNotExercise = !item.textContent.toLowerCase().includes('exercise');
          
          // Consider it a video if it has any video-like properties and isn't clearly non-video content
          return (hasPlayIcon || mentionsVideo || hasTime || hasVideoElement || hasVideoClass) && 
                  isNotQuiz && isNotExercise;
        })
        .map(lecture => {
          // Extract title with fallbacks
          const title = lecture.querySelector('h3, h4, span[class*="title"]')?.innerText.trim() || 
                        lecture.textContent.split('\n')[0].trim() || 
                        'Untitled Lecture';
          
          // Try to find duration
          const durationMatch = lecture.textContent.match(/(\d+:\d+)/);
          const duration = durationMatch ? durationMatch[0] : '';
          
          return { 
            title: title.substring(0, 100) || 'Untitled Lecture', // Limit title length
            duration, 
            isVideo: true,
            element: lecture
          };
        });
      
      // If we have lectures for this section, add it to course data
      if (videoLectures.length > 0) {
        // Clean up data for storage (remove DOM references)
        const cleanLectures = videoLectures.map(({ title, duration, isVideo }) => ({ title, duration, isVideo }));
        
        courseData.push({
          section: sectionTitle,
          lectures: cleanLectures,
          originalElements: videoLectures
        });
      }
    } catch (err) {
      console.warn('Error processing alternative section:', err);
    }
  }
  
  return courseData;
}

// Navigate to a specific lecture
async function navigateToLecture(sectionIndex, lectureIndex) {
  console.log(`Navigating to section ${sectionIndex + 1}, lecture ${lectureIndex + 1}...`);
  
  // Wait for the sidebar to be visible with increased timeout
  try {
    await waitForElement('[data-purpose="sidebar"], .ud-component--course-taking--curriculum-sidebar', 30000);
    console.log('Sidebar found for navigation');
    
    // Get course data from the background script
    const recordingStatus = await new Promise(resolve => {
      chrome.runtime.sendMessage({action: 'getRecordingStatus'}, result => resolve(result));
    });
    
    if (!recordingStatus || !recordingStatus.isRecording) {
      throw new Error('Recording has stopped');
    }
    
    const courseData = recordingStatus.courseData;
    if (!courseData || !Array.isArray(courseData) || courseData.length === 0) {
      throw new Error('No course data available for navigation');
    }
    
    // Validate indices
    if (sectionIndex >= courseData.length) {
      throw new Error(`Section index ${sectionIndex} out of bounds (total: ${courseData.length})`);
    }
    
    const section = courseData[sectionIndex];
    if (lectureIndex >= section.lectures.length) {
      throw new Error(`Lecture index ${lectureIndex} out of bounds (total: ${section.lectures.length})`);
    }
    
    // Get section and lecture info
    const sectionTitle = section.section;
    const lectureTitle = section.lectures[lectureIndex].title;
    
    console.log(`Navigating to: ${sectionTitle} > ${lectureTitle}`);
    
    // Try multiple navigation methods in order of preference
    
    // Method 1: Try to find the lecture directly in the sidebar
    try {
      console.log('Attempting direct lecture navigation...');
      
      // Make sure all sections are expanded first
      const expandButtons = document.querySelectorAll(
        '[data-purpose="expand-all"], ' + 
        'button[aria-label="Expand all sections"], ' +
        'button.ud-btn-ghost[aria-label*="all sections"]'
      );
      
      if (expandButtons && expandButtons.length > 0) {
        console.log('Clicking "Expand All" button...');
        expandButtons[0].click();
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log('No "Expand All" button found for navigation');
      }
      
      // Try to find the exact lecture by title
      const lectureElements = Array.from(document.querySelectorAll(
        '[data-purpose^="curriculum-item-"], ' +
        '.ud-block-list-item, ' +
        '.curriculum-item-link, ' +
        'div[class*="item--"], ' +
        '[data-purpose*="lecture"]'
      ));
      
      console.log(`Found ${lectureElements.length} potential lecture elements`);
      
      // Find lecture by exact title match
      let lectureElement = lectureElements.find(el => {
        const titleEl = el.querySelector('[data-purpose="item-title"], .ud-block-list-item-content, .item-title');
        return titleEl && titleEl.innerText.trim() === lectureTitle;
      });
      
      // If exact match fails, try partial match
      if (!lectureElement) {
        console.log('Exact title match failed, trying partial match...');
        lectureElement = lectureElements.find(el => {
          return el.textContent.includes(lectureTitle);
        });
      }
      
      // If we found the lecture, click on it
      if (lectureElement) {
        console.log('Found lecture by title match, clicking...');
        
        const playButton = lectureElement.querySelector('button[aria-label^="Play"], [data-purpose="play-button"], a');
        if (playButton) {
          playButton.click();
          await new Promise(resolve => setTimeout(resolve, 5000));
          return { sectionTitle, lectureTitle };
        } else {
          console.log('No play button found, trying to click the lecture element itself');
          lectureElement.click();
          await new Promise(resolve => setTimeout(resolve, 5000));
          return { sectionTitle, lectureTitle };
        }
      }
      
      console.log('Could not find lecture by title, trying alternative methods...');
    } catch (err) {
      console.warn('Error in direct lecture navigation:', err);
    }
    
    // Method 2: Try using URL navigation
    try {
      console.log('Attempting URL-based navigation...');
      
      // First check if we're already on a lecture page
      const currentUrl = window.location.href;
      console.log('Current URL:', currentUrl);
      
      // Get current lecture ID if present in URL
      const lectureMatch = currentUrl.match(/\/lecture\/(\d+)/);
      if (lectureMatch) {
        console.log('Currently on a lecture page');
        
        // Try to find next button and click it for sequential navigation
        const nextButton = document.querySelector(
          '[data-purpose="go-to-next-lesson"], ' +
          'button[aria-label*="Next"], ' +
          '[class*="btn--next"], ' +
          'a[data-purpose="next-lesson"]'
        );
        
        if (nextButton) {
          console.log('Found next button, clicking it...');
          nextButton.click();
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Check if we navigated correctly
          const newTitle = document.querySelector('.ud-heading-xxl[data-purpose="lecture-title"]')?.innerText.trim();
          console.log('New lecture title:', newTitle);
          
          return { sectionTitle, lectureTitle: newTitle || lectureTitle };
        }
      }
      
      // Try to navigate to a lecture URL pattern
      console.log('Attempting to find lecture URL from sidebar...');
      const lectureLinks = Array.from(document.querySelectorAll('a[href*="lecture"]'));
      
      if (lectureLinks.length > 0) {
        console.log(`Found ${lectureLinks.length} lecture links`);
        
        // Try to find by section and lecture indices
        const sectionElements = document.querySelectorAll(
          '[data-purpose^="section-panel-"], .ud-accordion-panel, [data-purpose="curriculum-section"]'
        );
        
        if (sectionElements && sectionElements.length > sectionIndex) {
          console.log('Found sections in sidebar');
          const sectionLectureLinks = Array.from(
            sectionElements[sectionIndex].querySelectorAll('a[href*="lecture"]')
          );
          
          if (sectionLectureLinks && sectionLectureLinks.length > lectureIndex) {
            console.log('Found target lecture link by index, clicking...');
            sectionLectureLinks[lectureIndex].click();
            await new Promise(resolve => setTimeout(resolve, 5000));
            return { sectionTitle, lectureTitle };
          }
        }
        
        // Fallback: Try to find by title approximate match
        for (const link of lectureLinks) {
          if (link.textContent.includes(lectureTitle) || 
              lectureTitle.includes(link.textContent.trim())) {
            console.log('Found lecture link by title match, clicking...');
            link.click();
            await new Promise(resolve => setTimeout(resolve, 5000));
            return { sectionTitle, lectureTitle };
          }
        }
        
        // Last resort: click the first lecture link as a starting point
        console.log('Navigation methods failed, clicking first lecture link as fallback...');
        lectureLinks[0].click();
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Try to use next buttons to navigate forward
        for (let i = 0; i < sectionIndex * 100 + lectureIndex; i++) {
          const nextButton = document.querySelector(
            '[data-purpose="go-to-next-lesson"], ' +
            'button[aria-label*="Next"], ' +
            '[class*="btn--next"], ' +
            'a[data-purpose="next-lesson"]'
          );
          
          if (!nextButton) break;
          
          console.log(`Sequential navigation step ${i + 1}...`);
          nextButton.click();
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // Check where we ended up
        const newTitle = document.querySelector('.ud-heading-xxl[data-purpose="lecture-title"]')?.innerText.trim();
        console.log('Final lecture title after sequential navigation:', newTitle);
        
        return { sectionTitle, lectureTitle: newTitle || lectureTitle };
      }
    } catch (err) {
      console.warn('Error in URL-based navigation:', err);
    }
    
    // If all our methods fail, return the expected titles but log an error
    console.error('All navigation methods failed, using fallback titles');
    return { sectionTitle, lectureTitle };
  } catch (error) {
    console.error('Error navigating to lecture:', error);
    throw error;
  }
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

// Add this new function to force moving to the next lecture after an error
function forceNextLecture(sectionTitle, lectureTitle, errorMessage) {
  console.log('Forcing move to next lecture after error');
  
  // First try to send the error message to background script
  chrome.runtime.sendMessage({
    action: 'transcriptCaptured',
    sectionTitle: sectionTitle,
    lectureTitle: lectureTitle,
    transcript: [errorMessage]
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error sending error transcript:', chrome.runtime.lastError);
      
      // If we can't send the transcript, try sending a processing error
      chrome.runtime.sendMessage({
        action: 'processingError',
        error: `Failed to capture transcript: ${errorMessage}`
      }, (response2) => {
        if (chrome.runtime.lastError) {
          console.error('Failed to send processing error too:', chrome.runtime.lastError);
          
          // Last resort - try to restart after timeout
          setTimeout(() => {
            // Try to restart the whole process
            chrome.runtime.sendMessage({
              action: 'getRecordingStatus'
            }, (status) => {
              if (status && status.isRecording) {
                updateProgressPanel('Attempting emergency recovery...');
                
                // Force the background page to continue to the next lecture
                chrome.runtime.sendMessage({
                  action: 'forceNextLecture'
                });
              }
            });
          }, 10000); // Wait 10 seconds before attempting recovery
        }
      });
    }
  });
  
  // Update UI to show we're trying to move forward
  updateProgressPanel(`Error recorded. Attempting to continue...`);
} 