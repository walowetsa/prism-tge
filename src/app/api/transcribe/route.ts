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
      process.env.NEXT_PUBLIC_SERVER_URL || "http://192.168.40.101:3000";

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
 * Get the correct server URL for external access
 */
function getExternalServerUrl(): string {
  const possibleUrls = [
    process.env.NEXT_PUBLIC_SERVER_URL,
    process.env.NETWORK_URL,
    process.env.PUBLIC_URL,
  ].filter(Boolean) as string[];

  const serverUrl = possibleUrls[0] || 'http://192.168.40.101:3000';
  console.log(`Using external server URL: ${serverUrl}`);
  return serverUrl;
}

/**
 * AGGRESSIVE: Try direct URL first with multiple fallback strategies
 */
async function getAudioUrlForAssemblyAI(sftpFilename: string): Promise<string> {
  console.log("=== STARTING AUDIO URL RESOLUTION ===");
  console.log("Original SFTP filename:", sftpFilename);
  
  // STEP 1: Try direct URL approach (fastest, no download needed)
  try {
    console.log("🚀 STEP 1: Attempting direct URL approach...");
    
    const decodedFilename = decodeURIComponent(sftpFilename);
    const serverUrl = getExternalServerUrl();
    const directUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
    
    console.log("Testing direct URL:", directUrl);
    
    // Quick HEAD request to verify accessibility
    const headResponse = await fetch(directUrl, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(20000) // 20 second timeout for verification
    });
    
    if (headResponse.ok) {
      const contentLength = headResponse.headers.get('content-length');
      const sizeInMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0;
      
      console.log(`✅ Direct URL verified! File size: ${sizeInMB.toFixed(2)}MB`);
      console.log(`🎯 Using direct URL: ${directUrl}`);
      
      return directUrl;
    } else {
      throw new Error(`Direct URL not accessible: ${headResponse.status}`);
    }
    
  } catch (directError) {
    console.log(`❌ Direct URL failed: ${directError instanceof Error ? directError.message : 'Unknown error'}`);
  }
  
  // STEP 2: If direct URL fails, try download and upload (slower but more reliable)
  console.log("🔄 STEP 2: Falling back to download+upload approach...");
  
  try {
    // Check file size first to avoid downloading huge files
    const decodedFilename = decodeURIComponent(sftpFilename);
    const serverUrl = getExternalServerUrl();
    const downloadUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(decodedFilename)}`;
    
    console.log("Checking file size before download...");
    const sizeCheckResponse = await fetch(downloadUrl, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(15000)
    });
    
    if (sizeCheckResponse.ok) {
      const contentLength = sizeCheckResponse.headers.get('content-length');
      if (contentLength) {
        const sizeInMB = parseInt(contentLength) / (1024 * 1024);
        console.log(`File size: ${sizeInMB.toFixed(2)}MB`);
        
        // Skip download if file is too large (likely to timeout)
        if (sizeInMB > 100) {
          throw new Error(`File too large for download approach: ${sizeInMB.toFixed(2)}MB`);
        }
      }
    }
    
    // Download the file
    console.log("Downloading file...");
    const downloadResponse = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(120000) // 2 minute timeout for download
    });
    
    if (!downloadResponse.ok) {
      throw new Error(`Download failed: ${downloadResponse.status}`);
    }
    
    const audioBlob = await downloadResponse.blob();
    console.log(`Downloaded blob: ${audioBlob.size} bytes`);
    
    if (audioBlob.size === 0) {
      throw new Error("Downloaded file is empty");
    }
    
    // Upload to AssemblyAI
    const uploadUrl = await uploadToAssemblyAI(audioBlob, process.env.ASSEMBLYAI_API_KEY!, sftpFilename);
    console.log(`✅ Upload successful: ${uploadUrl}`);
    
    return uploadUrl;
    
  } catch (downloadError) {
    console.error("❌ Download+upload approach failed:", downloadError);
    throw new Error(`All audio processing approaches failed. Last error: ${downloadError instanceof Error ? downloadError.message : 'Unknown error'}`);
  }
}

/**
 * Upload to AssemblyAI with better error handling
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string, originalFilename?: string): Promise<string> {
  console.log("Uploading to AssemblyAI:", {
    size: audioBlob.size,
    sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2),
    originalFilename
  });

  const formData = new FormData();
  let filename = 'audio.wav';
  
  if (originalFilename) {
    const decodedFilename = decodeURIComponent(originalFilename);
    filename = decodedFilename.split('/').pop() || 'audio.wav';
    if (!filename.match(/\.(wav|mp3|flac|m4a|aac|ogg)$/i)) {
      filename = filename + '.wav';
    }
  }
  
  // Ensure proper audio MIME type
  const audioBlob2 = new Blob([audioBlob], { type: 'audio/wav' });
  formData.append("file", audioBlob2, filename);

  const sizeInMB = audioBlob.size / (1024 * 1024);
  const timeoutMs = Math.max(60000, Math.min(600000, sizeInMB * 10000)); // 10 seconds per MB, max 10 minutes
  
  console.log(`Upload timeout: ${timeoutMs / 1000} seconds`);

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
      throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
    }

    const uploadData = await uploadResponse.json();
    return uploadData.upload_url;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Upload timed out after ${timeoutMs / 1000} seconds`);
    }
    throw error;
  }
}

/**
 * Helper function to perform topic categorization
 */
async function performTopicCategorization(transcriptData: any) {
  try {
    const serverUrl = getExternalServerUrl();

    const response = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transcript: transcriptData }),
      signal: AbortSignal.timeout(45000), // Increased to 45 seconds
    });

    if (!response.ok) {
      console.error("Topic categorization failed:", response.status);
      return null;
    }

    const topicData = await response.json();

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
  const requestStartTime = Date.now();
  const MAX_REQUEST_TIME = 10 * 60 * 1000; // INCREASED to 10 minutes for very large files
  
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

    console.log("=== TRANSCRIPTION REQUEST START ===");
    console.log("Request details:", {
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

    // STEP 1: Get audio URL using the robust strategy
    try {
      console.log("=== AUDIO PROCESSING PHASE ===");
      
      if (isDirectSftpFile && sftpFilename) {
        uploadUrl = await getAudioUrlForAssemblyAI(sftpFilename);
      } else if (audioUrl) {
        console.log("Using provided audio URL:", audioUrl);
        uploadUrl = audioUrl;
      } else {
        throw new Error("No valid audio source provided");
      }

      console.log(`✅ Audio URL ready: ${uploadUrl}`);

    } catch (audioError) {
      console.error("❌ Audio processing failed:", audioError);
      
      return NextResponse.json(
        { 
          error: "Failed to process audio file",
          details: audioError instanceof Error ? audioError.message : "Unknown error",
          stage: "audio_processing"
        },
        { status: 500 }
      );
    }

    // STEP 2: Submit to AssemblyAI
    console.log("=== ASSEMBLYAI SUBMISSION PHASE ===");
    
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
        signal: AbortSignal.timeout(45000), // 45 second timeout for submission
      }
    );

    if (!transcriptResponse.ok) {
      const errorData = await transcriptResponse.json();
      console.error("AssemblyAI submission failed:", errorData);
      return NextResponse.json(
        { error: "Failed to initiate transcription", details: errorData },
        { status: 500 }
      );
    }

    const { id } = await transcriptResponse.json();
    console.log(`✅ Transcription job created: ${id}`);

    // STEP 3: Poll for results with generous timeout
    console.log("=== POLLING PHASE ===");
    
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 300; // INCREASED to 300 (10 minutes at 2-second intervals)
    const pollInterval = 2000;

    while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
      const elapsed = Date.now() - requestStartTime;
      
      // Check overall timeout
      if (elapsed > MAX_REQUEST_TIME - 60000) { // Leave 1 minute buffer
        console.log(`⏰ Approaching ${MAX_REQUEST_TIME / 60000} minute timeout, stopping polling`);
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      attempts++;

      try {
        const statusResponse = await fetch(
          `https://api.assemblyai.com/v2/transcript/${id}`,
          {
            headers: { Authorization: apiKey },
            signal: AbortSignal.timeout(20000), // 20 second timeout for status checks
          }
        );

        if (!statusResponse.ok) {
          console.error("Status check failed:", statusResponse.status);
          continue;
        }

        transcript = await statusResponse.json();
        status = transcript.status;
        
        // Log progress every minute
        if (attempts % 30 === 0) {
          console.log(`📊 Status: ${status}, attempt: ${attempts}/${maxAttempts}, elapsed: ${Math.round(elapsed/1000)}s`);
        }
        
      } catch (statusError) {
        console.error("Status check error:", statusError);
        if (attempts >= maxAttempts - 10) break; // Stop if near the end
      }
    }

    // STEP 4: Handle results
    console.log("=== RESULTS PHASE ===");
    
    if (status === "completed" && transcript) {
      console.log("✅ Transcription completed successfully");

      // Process results
      if (transcript.utterances) {
        transcript.utterances = transcript.utterances.map((utterance: any) => ({
          ...utterance,
          speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      if (transcript.words) {
        transcript.words = transcript.words.map((word: any) => ({
          ...word,
          speakerRole: word.speaker === "A" ? "Agent" : "Customer",
        }));
      }

      // Topic categorization (optional, don't fail if it doesn't work)
      let categorization = null;
      if (transcript.utterances && transcript.utterances.length > 0) {
        try {
          categorization = await performTopicCategorization(transcript);
        } catch (catError) {
          console.error("⚠️ Categorization failed (continuing anyway):", catError);
        }
        
        transcript.topic_categorization = categorization ? {
          primary_topic: categorization.primary_category,
          all_topics: categorization.topic_categories,
          confidence: categorization.confidence,
        } : {
          primary_topic: "Uncategorised",
          all_topics: ["Uncategorised"],
          confidence: 0,
        };
      }

      // Save to Supabase (optional, don't fail if it doesn't work)
      if (callData) {
        try {
          await saveToSupabase(callData, transcript, categorization);
          console.log("✅ Saved to Supabase");
        } catch (supabaseError) {
          console.error("⚠️ Supabase save failed (continuing anyway):", supabaseError);
        }
      }

      const totalTime = Date.now() - requestStartTime;
      console.log(`🎉 TRANSCRIPTION COMPLETE in ${Math.round(totalTime/1000)}s`);

      return NextResponse.json({
        ...transcript,
        status: "completed",
        call_data: callData || null,
      });

    } else if (status === "error") {
      console.error("❌ AssemblyAI transcription error:", transcript?.error);
      return NextResponse.json(
        {
          error: `Transcription failed: ${transcript?.error || "Unknown error"}`,
          status: "error",
        },
        { status: 500 }
      );
      
    } else {
      console.error("⏰ Transcription timed out or failed");
      return NextResponse.json(
        {
          error: "Transcription timed out. The audio file might be very long or the service is busy. Please try again.",
          status: "timeout",
          transcription_id: id,
          elapsed_time: Math.round((Date.now() - requestStartTime) / 1000),
        },
        { status: 504 }
      );
    }

  } catch (error) {
    console.error("💥 TRANSCRIPTION REQUEST FAILED:", error);
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