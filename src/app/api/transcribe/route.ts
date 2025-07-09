/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

/**
 * Helper function to save transcription to Supabase
 */
async function saveToSupabase(
  callData: any,
  transcriptData: any,
  categorization: any = null
) {
  try {
    const serverUrl =
      process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

    console.log(`Saving transcription to Supabase for call ID: ${callData.contact_id}`);

    const payload = {
      contact_id: callData.contact_id,
      recording_location: callData.recording_location || "",
      transcript_text: transcriptData.text || "",
      queue_name: callData.queue_name || null,
      agent_username: callData.agent_username || "",
      initiation_timestamp: callData.initiation_timestamp || new Date().toISOString(),
      speaker_data: transcriptData.utterances
        ? JSON.stringify(transcriptData.utterances)
        : null,
      sentiment_analysis: transcriptData.sentiment_analysis_results
        ? JSON.stringify(transcriptData.sentiment_analysis_results)
        : null,
      entities: transcriptData.entities
        ? JSON.stringify(transcriptData.entities)
        : null,
      disposition_title: callData.disposition_title || null,
      call_summary: transcriptData.summary || null,
      campaign_name: callData.campaign_name || null,
      campaign_id: callData.campaign_id || null,
      customer_cli: callData.customer_cli || null,
      agent_hold_time: callData.agent_hold_time || null,
      total_hold_time: callData.total_hold_time || null,
      time_in_queue: callData.time_in_queue || null,
      call_duration: callData.total_call_time || null,
      categories: categorization?.topic_categories 
        ? JSON.stringify(categorization.topic_categories) 
        : (transcriptData.topic_categorization?.all_topics ? JSON.stringify(transcriptData.topic_categorization.all_topics) : null),
      primary_category: categorization?.primary_category || transcriptData.topic_categorization?.primary_topic || null,
    };

    const response = await fetch(`${serverUrl}/api/supabase/save-transcription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Error response from Supabase API:`, errorText);
      throw new Error(`Supabase save failed: ${response.status}`);
    }

    const result = await response.json();
    console.log(`Successfully saved to Supabase:`, result.data?.id || result.data?.contact_id);
    return result.data;
  } catch (error) {
    console.error("Error saving to Supabase:", error);
    throw error;
  }
}

/**
 * IMPROVED: Get the correct server URL for external access
 */
function getExternalServerUrl(): string {
  // Priority order for external URLs that AssemblyAI can access
  const possibleUrls = [
    process.env.NEXT_PUBLIC_SERVER_URL,
    process.env.NETWORK_URL,
    process.env.PUBLIC_URL,
  ].filter(Boolean) as string[];

  // Always ensure we have a fallback URL
  const serverUrl = possibleUrls[0] || 'http://192.168.40.101:3000';
  console.log(`Using external server URL: ${serverUrl}`);
  return serverUrl;
}

/**
 * IMPROVED: Get the correct internal URL for server-to-server communication
 */
function getInternalServerUrl(): string {
  const possibleUrls = [
    process.env.NETWORK_URL,
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_SERVER_URL,
  ].filter(Boolean) as string[];

  // Always ensure we have a fallback URL, prioritize network IP over localhost
  const serverUrl = possibleUrls[0] || 
    'http://192.168.40.101:3000' || 
    `http://localhost:${process.env.PORT || 3000}`;
  
  console.log(`Using internal server URL: ${serverUrl}`);
  return serverUrl;
}

/**
 * Get a public URL for SFTP file that AssemblyAI can access directly
 */
async function getPublicAudioUrl(sftpFilename: string): Promise<string> {
  console.log("Creating public URL for SFTP file:", sftpFilename);

  // FIXED: Properly decode the filename to handle URL encoding
  const decodedFilename = decodeURIComponent(sftpFilename);
  console.log("Decoded filename:", decodedFilename);

  const serverUrl = getExternalServerUrl();
  const publicUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
  
  console.log("Public audio URL:", publicUrl);

  // Verify the file is accessible before returning the URL
  try {
    const response = await fetch(publicUrl, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(30000) // Increased timeout for HEAD request
    });
    
    if (!response.ok) {
      throw new Error(`File not accessible: ${response.status} - ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const sizeInMB = parseInt(contentLength) / (1024 * 1024);
      console.log(`Audio file verified: ${sizeInMB.toFixed(2)}MB`);
      
      // Allow larger files for direct URL approach since it's more efficient
      if (sizeInMB > 200) {
        console.log(`File large but using direct URL: ${sizeInMB.toFixed(2)}MB`);
      }
    }

    return publicUrl;
  } catch (error) {
    console.error("Failed to verify public URL:", error);
    throw new Error(`Audio file not accessible at public URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Fallback function to download and upload for files that can't be accessed directly
 */
async function getAudioFromSFTPWithFallback(sftpFilename: string): Promise<Blob> {
  console.log("Downloading SFTP file as fallback:", sftpFilename);

  // FIXED: Properly decode the filename
  const decodedFilename = decodeURIComponent(sftpFilename);
  console.log("Decoded filename for download:", decodedFilename);

  const baseUrl = getInternalServerUrl();
  const downloadUrl = `${baseUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
  
  console.log("Internal download URL:", downloadUrl);

  try {
    // INCREASED: Timeout to 3 minutes for large files
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes

    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'TranscriptionService/1.0',
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("SFTP download failed:", {
        status: response.status,
        statusText: response.statusText,
        url: downloadUrl,
        error: errorText.substring(0, 500)
      });
      throw new Error(`SFTP download failed: ${response.status} - ${response.statusText}`);
    }

    // Check content length before downloading
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const sizeInMB = parseInt(contentLength) / (1024 * 1024);
      console.log(`Downloading file: ${sizeInMB.toFixed(2)}MB`);
      
      if (sizeInMB > 300) { // Increased limit
        throw new Error(`File too large: ${sizeInMB.toFixed(2)}MB (max: 300MB)`);
      }
    }

    const audioBlob = await response.blob();
    
    console.log("Successfully downloaded audio blob:", {
      size: audioBlob.size,
      type: audioBlob.type,
      sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2)
    });

    if (audioBlob.size === 0) {
      throw new Error("Audio file is empty");
    }

    if (audioBlob.size < 100) {
      throw new Error(`Audio file too small: ${audioBlob.size} bytes`);
    }

    return audioBlob;

  } catch (error) {
    console.error("Error downloading SFTP file:", error);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error("SFTP download timed out after 3 minutes");
    }
    
    throw new Error(`Failed to download audio file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Function to upload audio to AssemblyAI with better timeout handling
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string, originalFilename?: string): Promise<string> {
  console.log("Uploading audio to AssemblyAI:", {
    size: audioBlob.size,
    sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2),
    originalFilename
  });

  // Create form data with proper filename
  const formData = new FormData();
  let filename = 'audio.wav'; // Default filename
  
  if (originalFilename) {
    // Extract just the filename from the path and decode any URL encoding
    const decodedFilename = decodeURIComponent(originalFilename);
    filename = decodedFilename.split('/').pop() || 'audio.wav';
    
    // Ensure it has a proper audio extension
    if (!filename.match(/\.(wav|mp3|flac|m4a|aac|ogg)$/i)) {
      filename = filename + '.wav';
    }
  }
  
  // Create a new blob with proper MIME type to ensure AssemblyAI recognizes it as audio
  const audioBlob2 = new Blob([audioBlob], { type: 'audio/wav' });
  formData.append("file", audioBlob2, filename);

  // Increased timeout based on file size
  const sizeInMB = audioBlob.size / (1024 * 1024);
  const timeoutMs = Math.max(60000, Math.min(300000, sizeInMB * 5000)); // 5 seconds per MB, max 5 minutes
  
  console.log(`Upload timeout set to ${timeoutMs / 1000} seconds for ${sizeInMB.toFixed(2)}MB file`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        Authorization: apiKey,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      console.error("AssemblyAI upload error:", errorData);
      throw new Error(`Failed to upload to AssemblyAI: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    console.log("Upload successful. Upload URL:", uploadData.upload_url);
    return uploadData.upload_url;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Upload to AssemblyAI timed out after ${timeoutMs / 1000} seconds`);
    }
    
    throw error;
  }
}

/**
 * Helper function to perform topic categorization
 */
async function performTopicCategorization(transcriptData: any) {
  try {
    const serverUrl = getInternalServerUrl();

    console.log("Sending transcript for categorization");

    const response = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transcript: transcriptData }),
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      console.error("Topic categorization failed:", response.status);
      return null;
    }

    const topicData = await response.json();
    console.log("Topic categorization received:", topicData);

    if (topicData.topic_categories && topicData.topic_categories.length > 0) {
      return {
        primary_category: topicData.primary_category,
        topic_categories: topicData.topic_categories,
        confidence: topicData.confidence || 1.0,
      };
    }

    return null;
  } catch (error) {
    console.error("Error in topic categorization:", error);
    return null;
  }
}

export async function POST(request: Request) {
  // Set timeout for the entire request
  const requestStartTime = Date.now();
  const MAX_REQUEST_TIME = 6 * 60 * 1000; // Increased back to 6 minutes for large files
  
  try {
    const body = await request.json();
    const {
      audioUrl,
      speakerCount = 2,
      filename,
      isDirectSftpFile = false,
      sftpFilename = null,
      callData = null,
    } = body;

    console.log("Transcription request received:", {
      filename,
      isDirectSftpFile,
      sftpFilename,
      hasCallData: !!callData,
      callId: callData?.contact_id
    });

    // Validate required parameters
    if (!audioUrl && !isDirectSftpFile) {
      return NextResponse.json(
        { error: "Either Audio URL or SFTP filename is required" },
        { status: 400 }
      );
    }

    if (!filename) {
      return NextResponse.json(
        { error: "Filename is required for processing" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "AssemblyAI API key is not configured" },
        { status: 500 }
      );
    }

    let uploadUrl: string;

    try {
      if (isDirectSftpFile && sftpFilename) {
        console.log("Processing SFTP file:", sftpFilename);
        
        // IMPROVED: Try direct URL approach first for better performance
        try {
          console.log("Attempting direct URL approach...");
          uploadUrl = await getPublicAudioUrl(sftpFilename);
          console.log("Using direct URL approach successfully");
        } catch (directUrlError) {
          console.log("Direct URL failed, falling back to download+upload:", directUrlError);
          
          // Fallback to download and upload
          const audioBlob = await getAudioFromSFTPWithFallback(sftpFilename);
          uploadUrl = await uploadToAssemblyAI(audioBlob, apiKey, sftpFilename);
        }
        
      } else if (audioUrl) {
        console.log("Processing audio URL:", audioUrl);
        
        if (audioUrl.startsWith('http')) {
          uploadUrl = audioUrl;
        } else {
          const response = await fetch(audioUrl, {
            signal: AbortSignal.timeout(60000)
          });
          if (!response.ok) {
            throw new Error(`Failed to fetch audio: ${response.status}`);
          }
          
          const audioBlob = await response.blob();
          uploadUrl = await uploadToAssemblyAI(audioBlob, apiKey, filename);
        }
      } else {
        throw new Error("No valid audio source provided");
      }

    } catch (error) {
      console.error("Error processing audio:", error);
      
      let errorMessage = "Failed to process audio file";
      if (error instanceof Error) {
        if (error.message.includes("timed out")) {
          errorMessage = "Audio download timed out - file might be too large";
        } else if (error.message.includes("too large")) {
          errorMessage = "Audio file is too large for processing";
        } else if (error.message.includes("not accessible")) {
          errorMessage = "Audio file is not accessible from the server";
        } else {
          errorMessage = error.message;
        }
      }
      
      return NextResponse.json(
        { 
          error: errorMessage,
          details: error instanceof Error ? error.message : "Unknown error",
          stage: "audio_processing"
        },
        { status: 500 }
      );
    }

    console.log("Submitting transcription request to AssemblyAI with URL:", uploadUrl);

    // Submit transcription request
    const transcriptResponse = await fetch(
      "https://api.assemblyai.com/v2/transcript",
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: uploadUrl,
          speech_model: "best",
          speaker_labels: true,
          speakers_expected: speakerCount || 2,
          summarization: true,
          summary_model: "conversational",
          summary_type: "paragraph",
          entity_detection: true,
          sentiment_analysis: true,
          filter_profanity: false,
          auto_highlights: true,
          punctuate: true,
          format_text: true,
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!transcriptResponse.ok) {
      const errorData = await transcriptResponse.json();
      console.error("AssemblyAI transcription request failed:", errorData);
      return NextResponse.json(
        { error: "Failed to initiate transcription", details: errorData },
        { status: 500 }
      );
    }

    const { id } = await transcriptResponse.json();
    console.log(`Transcription job created with ID: ${id}`);

    // Poll for transcription result with increased timeout for large files
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 180; // Back to 180 (6 minutes) for large files
    const pollInterval = 2000;

    while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
      // Check if we're approaching the overall timeout
      const elapsed = Date.now() - requestStartTime;
      if (elapsed > MAX_REQUEST_TIME - 30000) {
        console.log("Approaching request timeout, stopping polling");
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      attempts++;

      try {
        const statusResponse = await fetch(
          `https://api.assemblyai.com/v2/transcript/${id}`,
          {
            headers: {
              Authorization: apiKey,
            },
            signal: AbortSignal.timeout(15000), // Increased timeout for status checks
          }
        );

        if (!statusResponse.ok) {
          console.error("Status check failed:", statusResponse.status);
          continue;
        }

        transcript = await statusResponse.json();
        status = transcript.status;
        
        // Log progress every 30 seconds
        if (attempts % 15 === 0) {
          console.log(`Transcription status: ${status}, attempt: ${attempts}/${maxAttempts}, elapsed: ${Math.round(elapsed/1000)}s`);
        }
        
      } catch (error) {
        console.error("Error checking transcription status:", error);
        if (attempts >= maxAttempts - 5) {
          throw error;
        }
      }
    }

    // Handle transcription results
    if (status === "completed" && transcript) {
      console.log("Transcription completed successfully");

      // Map speaker labels
      if (transcript.utterances && transcript.utterances.length > 0) {
        transcript.utterances = transcript.utterances.map((utterance: any) => ({
          ...utterance,
          speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      if (transcript.words && transcript.words.length > 0) {
        transcript.words = transcript.words.map((word: any) => ({
          ...word,
          speakerRole: word.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      // Perform topic categorization (with timeout protection)
      let categorization = null;
      if (transcript.utterances && transcript.utterances.length > 0) {
        try {
          categorization = await performTopicCategorization(transcript);
        } catch (catError) {
          console.error("Categorization failed, continuing without it:", catError);
        }
        
        if (categorization) {
          transcript.topic_categorization = {
            primary_topic: categorization.primary_category,
            all_topics: categorization.topic_categories,
            confidence: categorization.confidence,
          };
        } else {
          transcript.topic_categorization = {
            primary_topic: "Uncategorised",
            all_topics: ["Uncategorised"],
            confidence: 0,
          };
        }
      }

      // Save to Supabase if we have call data
      if (callData) {
        try {
          console.log("Saving transcription to Supabase...");
          await saveToSupabase(callData, transcript, categorization);
          console.log("Successfully saved to Supabase");
        } catch (supabaseError) {
          console.error("Failed to save to Supabase:", supabaseError);
          // Don't fail the request if Supabase save fails
        }
      }

      return NextResponse.json({
        ...transcript,
        status: "completed",
        call_data: callData || null,
      });

    } else if (status === "error") {
      console.error("Transcription failed:", transcript?.error);
      return NextResponse.json(
        {
          error: `Transcription failed: ${transcript?.error || "Unknown error"}`,
          status: "error",
        },
        { status: 500 }
      );
      
    } else if (attempts >= maxAttempts || (Date.now() - requestStartTime) > MAX_REQUEST_TIME) {
      console.error("Transcription timed out");
      return NextResponse.json(
        {
          error: "Transcription timed out. Please try again or check if the audio file is too long.",
          status: "timeout",
          transcription_id: id,
        },
        { status: 504 }
      );
      
    } else {
      console.error("Transcription failed with unexpected status:", status);
      return NextResponse.json(
        {
          error: `Transcription failed with status: ${status}`,
          details: transcript?.error || "Unknown error",
          status: status,
        },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error("Error in transcribe API route:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        message: error instanceof Error ? error.message : "Unknown Error",
        status: "error"
      },
      { status: 500 }
    );
  }
}