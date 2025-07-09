/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

/**
 * Helper function to save transcription to Supabase
 * @param callData The call log data from the frontend
 * @param transcriptData The complete transcript data from AssemblyAI
 * @param categorization The topic categorization data
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

    // Prepare the data payload matching the structure expected by CallLogDisplay
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
      // Add categorization data
      categories: categorization?.topic_categories 
        ? JSON.stringify(categorization.topic_categories) 
        : (transcriptData.topic_categorization?.all_topics ? JSON.stringify(transcriptData.topic_categorization.all_topics) : null),
      primary_category: categorization?.primary_category || transcriptData.topic_categorization?.primary_topic || null,
    };

    console.log("Supabase payload prepared:", {
      contact_id: payload.contact_id,
      agent_username: payload.agent_username,
      queue_name: payload.queue_name,
      has_transcript: !!payload.transcript_text,
      has_categories: !!payload.categories
    });

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

      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = {
          error: "Non-JSON response received",
          status: response.status,
          responseText: errorText.substring(0, 500),
        };
      }

      throw new Error(
        `Supabase save failed: ${response.status} - ${
          errorData.error || "Unknown error"
        }`
      );
    }

    const result = await response.json();
    console.log(
      `Successfully saved to Supabase:`,
      result.data?.id || result.data?.contact_id
    );
    return result.data;
  } catch (error) {
    console.error("Error saving to Supabase:", error);
    throw error; // Re-throw to handle in calling function
  }
}

/**
 * Helper function to validate if a blob appears to be an audio file
 * @param blob The blob to validate
 * @param filename The original filename
 * @returns Promise<boolean>
 */
async function validateAudioFile(blob: Blob, filename?: string): Promise<{ isValid: boolean; detectedType?: string; reason?: string }> {
  try {
    // Check file size
    if (blob.size < 100) {
      return { isValid: false, reason: "File too small to be valid audio" };
    }

    // Read first few bytes to detect file format
    const buffer = await blob.slice(0, 16).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    
    // Convert bytes to hex string for easier checking
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    console.log("File header bytes:", hex);
    
    // Check for common audio file signatures
    const signatures = {
      'wav': ['52494646', '57415645'], // RIFF...WAVE
      'mp3': ['494433', 'fff3', 'fff2', 'fffa', 'fffb'], // ID3, or MP3 frame headers
      'flac': ['664c6143'], // fLaC
      'm4a': ['66747970'], // ftyp (part of MP4 container)
      'ogg': ['4f676753'], // OggS
    };

    let detectedType = null;
    
    // Check WAV
    if (hex.startsWith('52494646') && hex.includes('57415645')) {
      detectedType = 'wav';
    }
    // Check MP3
    else if (hex.startsWith('494433') || hex.startsWith('fff')) {
      detectedType = 'mp3';
    }
    // Check FLAC
    else if (hex.startsWith('664c6143')) {
      detectedType = 'flac';
    }
    // Check M4A/MP4
    else if (hex.includes('66747970')) {
      detectedType = 'm4a';
    }
    // Check OGG
    else if (hex.startsWith('4f676753')) {
      detectedType = 'ogg';
    }

    if (detectedType) {
      console.log(`Detected audio format: ${detectedType}`);
      return { isValid: true, detectedType };
    } else {
      console.warn("No recognized audio format detected");
      console.log("First 16 bytes as text:", new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      
      // Sometimes files might be valid but not have standard headers
      // If filename suggests audio format, give it a chance
      if (filename) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const audioExts = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'wma'];
        if (ext && audioExts.includes(ext)) {
          console.log(`File extension suggests audio (${ext}), allowing despite unrecognized header`);
          return { isValid: true, detectedType: ext, reason: "Validated by file extension" };
        }
      }
      
      return { 
        isValid: false, 
        reason: `Unrecognized file format. Header: ${hex.substring(0, 16)}...` 
      };
    }
  } catch (error) {
    console.error("Error validating audio file:", error);
    return { isValid: false, reason: "Failed to validate file" };
  }
}

/**
 * Helper function to download a file from SFTP
* Helper function to download a file from SFTP (Fixed for server-side calls)
 * @param sftpFilename The filename or path in the SFTP server
 * @returns An audio blob
 */
async function getSftpAudio(sftpFilename: string) {
  console.log("Fetching SFTP file:", sftpFilename);

  try {
    // FIXED: Use localhost explicitly for server-side calls
    const port = process.env.PORT || 3000;
    const sftpApiUrl = `http://localhost:${port}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;

    console.log("SFTP API URL (server-side):", sftpApiUrl);

    const audioResponse = await fetch(sftpApiUrl, {
      method: 'GET',
      headers: {
        'Host': 'localhost',
        'User-Agent': 'TranscriptionService/1.0',
        'Accept': '*/*',
      },
      // Add timeout to prevent hanging
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    console.log("SFTP Response status:", audioResponse.status);
    
    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("SFTP download failed:", {
        status: audioResponse.status,
        statusText: audioResponse.statusText,
        headers: Object.fromEntries(audioResponse.headers.entries()),
        errorText: errorText.substring(0, 500)
      });
      
      // More specific error messages
      if (audioResponse.status === 404) {
        throw new Error(`SFTP file not found: ${sftpFilename}`);
      } else if (audioResponse.status === 401 || audioResponse.status === 403) {
        throw new Error(`SFTP authentication failed`);
      } else if (audioResponse.status >= 500) {
        throw new Error(`SFTP server error: ${audioResponse.status}`);
      } else {
        throw new Error(`SFTP download failed: ${audioResponse.status} - ${errorText.substring(0, 100)}`);
      }
    }

    // Log response headers for debugging
    console.log("SFTP Response headers:", Object.fromEntries(audioResponse.headers.entries()));

    const audioBlob = await audioResponse.blob();
    console.log("Retrieved audio blob:", {
      size: audioBlob.size,
      type: audioBlob.type,
      sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2)
    });

    // Validate file
    if (audioBlob.size === 0) {
      throw new Error("Retrieved audio file is empty");
    }

    if (audioBlob.size < 1000) {
      throw new Error(`Audio file too small: ${audioBlob.size} bytes`);
    }

    const maxSizeMB = 500;
    if (audioBlob.size > maxSizeMB * 1024 * 1024) {
      throw new Error(`Audio file too large: ${(audioBlob.size / (1024 * 1024)).toFixed(2)}MB`);
    }

    // Quick validation of file content
    const buffer = await audioBlob.slice(0, 16).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    
    console.log("File header (first 16 bytes):", hex);
    
    // Check for common audio signatures
    const isWav = hex.startsWith('52494646') && hex.includes('57415645');
    const isMp3 = hex.startsWith('494433') || hex.startsWith('fff');
    const isFlac = hex.startsWith('664c6143');
    const isM4a = hex.includes('66747970');
    const isOgg = hex.startsWith('4f676753');
    
    if (!isWav && !isMp3 && !isFlac && !isM4a && !isOgg) {
      console.warn("File header doesn't match common audio formats:", hex);
      // Check file extension as fallback
      const ext = sftpFilename.split('.').pop()?.toLowerCase();
      const audioExts = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'wma'];
      if (!ext || !audioExts.includes(ext)) {
        throw new Error(`File doesn't appear to be audio. Header: ${hex.substring(0, 16)}`);
      }
      console.log("Proceeding based on file extension:", ext);
    } else {
      console.log("Audio format detected from header");
    }

    return audioBlob;

  } catch (error) {
    console.error("Error in getSftpAudio:", error);
    
    if (error instanceof Error) {
      // Re-throw with more context
      throw new Error(`SFTP download failed for ${sftpFilename}: ${error.message}`);
    } else {
      throw new Error(`SFTP download failed for ${sftpFilename}: Unknown error`);
    }
  }
}

/**
 * Helper function to handle audio files from a URL
 * @param audioUrl The URL of the audio file
 * @returns An audio blob or URL
 */
async function getAudioFromUrl(audioUrl: string) {
  const isLocalPath = audioUrl.startsWith("/api/");

  if (isLocalPath) {
    const serverUrl =
      process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
    const fullAudioUrl = `${serverUrl}${audioUrl}`;

    console.log("Fetching audio from local path:", fullAudioUrl);

    const audioResponse = await fetch(fullAudioUrl);
    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      console.error("Failed to fetch audio file:", errorText);
      throw new Error(`Failed to fetch audio file: ${audioResponse.status}`);
    }

    const audioBlob = await audioResponse.blob();
    console.log("Audio blob size from local path:", audioBlob.size);

    if (audioBlob.size === 0) {
      throw new Error("Retrieved audio file is empty");
    }

    return audioBlob;
  } else {
    console.log("Using external audio URL:", audioUrl);
    return audioUrl;
  }
}

/**
 * Helper function to upload audio to AssemblyAI
 * @param audioBlob The audio blob or URL to upload
 * @param apiKey The AssemblyAI API key
 * @param originalFilename The original filename for format detection
 * @returns The upload URL for transcription
 */
async function uploadToAssemblyAI(audioBlob: Blob | string, apiKey: string, originalFilename?: string) {
  if (typeof audioBlob === "string") {
    return audioBlob;
  }

  console.log("Uploading audio blob to AssemblyAI:", {
    size: audioBlob.size,
    type: audioBlob.type,
    sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2),
    originalFilename
  });

  // Determine file extension and MIME type
  let filename = "audio.wav"; // default
  let mimeType = "audio/wav"; // default

  if (originalFilename) {
    const ext = originalFilename.split('.').pop()?.toLowerCase();
    console.log("File extension detected:", ext);
    
    switch (ext) {
      case 'mp3':
        filename = "audio.mp3";
        mimeType = "audio/mpeg";
        break;
      case 'wav':
        filename = "audio.wav";
        mimeType = "audio/wav";
        break;
      case 'flac':
        filename = "audio.flac";
        mimeType = "audio/flac";
        break;
      case 'm4a':
        filename = "audio.m4a";
        mimeType = "audio/mp4";
        break;
      case 'aac':
        filename = "audio.aac";
        mimeType = "audio/aac";
        break;
      case 'ogg':
        filename = "audio.ogg";
        mimeType = "audio/ogg";
        break;
      case 'wma':
        filename = "audio.wma";
        mimeType = "audio/x-ms-wma";
        break;
      default:
        console.warn(`Unknown audio format: ${ext}, using WAV as default`);
        filename = "audio.wav";
        mimeType = "audio/wav";
    }
  }

  console.log("Using filename:", filename, "with MIME type:", mimeType);

  const uploadFormData = new FormData();
  
  // Create a new Blob with the correct MIME type if needed
  const correctedBlob = audioBlob.type === mimeType 
    ? audioBlob 
    : new Blob([audioBlob], { type: mimeType });
    
  uploadFormData.append("file", correctedBlob, filename);

  console.log("Uploading to AssemblyAI with corrected blob:", {
    size: correctedBlob.size,
    type: correctedBlob.type,
    filename
  });

  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: apiKey,
    },
    body: uploadFormData,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    console.error("AssemblyAI upload error:", errorData);
    throw new Error(
      `Failed to upload audio to AssemblyAI: ${uploadResponse.status} - ${JSON.stringify(errorData)}`
    );
  }

  const uploadData = await uploadResponse.json();
  console.log("Upload successful. Upload URL:", uploadData.upload_url);
  return uploadData.upload_url;
}

/**
 * Helper function to perform topic categorization
 * @param transcriptData The transcript data to categorize
 * @returns Categorization results or null
 */
async function performTopicCategorization(transcriptData: any) {
  try {
    const serverUrl =
      process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

    console.log("Sending transcript for categorization:", {
      hasUtterances: !!(transcriptData.utterances && transcriptData.utterances.length > 0),
      utteranceCount: transcriptData.utterances?.length || 0,
      transcriptLength: transcriptData.text?.length || 0,
    });

    const topicResponse = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transcript: transcriptData }),
    });

    if (!topicResponse.ok) {
      const errorText = await topicResponse.text();
      console.error("Topic categorization failed:", topicResponse.status, errorText);
      return null;
    }

    const topicData = await topicResponse.json();
    console.log("Topic categorization received:", topicData);

    if (topicData.topic_categories && topicData.topic_categories.length > 0) {
      return {
        primary_category: topicData.primary_category,
        topic_categories: topicData.topic_categories,
        confidence: topicData.confidence || 1.0,
      };
    } else {
      console.warn("Categorization API returned invalid data:", topicData);
      return null;
    }
  } catch (error) {
    console.error("Error in topic categorization:", error);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      audioUrl,
      speakerCount = 2,
      filename,
      isDirectSftpFile = false,
      sftpFilename = null,
      // Call data from CallLogDisplay
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

    let fileToTranscribe;

    try {
      // Handle audio acquisition based on source type
      if (isDirectSftpFile && sftpFilename) {
        console.log("Processing SFTP file:", sftpFilename);
        const audioBlob = await getSftpAudio(sftpFilename);
        
        // Extract filename for format detection
        const originalFilename = sftpFilename.split('/').pop() || filename;
        console.log("Original filename for format detection:", originalFilename);
        
        fileToTranscribe = await uploadToAssemblyAI(audioBlob, apiKey, originalFilename);
      } else if (audioUrl) {
        console.log("Processing audio URL:", audioUrl);
        const audioSource = await getAudioFromUrl(audioUrl);
        fileToTranscribe = await uploadToAssemblyAI(audioSource, apiKey, filename);
      }
    } catch (error) {
      console.error("Error getting or uploading audio:", error);
      
      // Provide more specific error information
      let errorMessage = "Failed to process audio file";
      if (error instanceof Error) {
        if (error.message.includes("too small")) {
          errorMessage = "Audio file is too small or corrupted";
        } else if (error.message.includes("too large")) {
          errorMessage = "Audio file is too large";
        } else if (error.message.includes("Failed to fetch SFTP")) {
          errorMessage = "Cannot download audio file from server";
        } else if (error.message.includes("Failed to upload")) {
          errorMessage = "Cannot upload audio file to transcription service";
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

    console.log("Submitting transcription request to AssemblyAI...");

    // Submit the transcription request to AssemblyAI with enhanced parameters
    const transcriptResponse = await fetch(
      "https://api.assemblyai.com/v2/transcript",
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: fileToTranscribe,
          speech_model: "slam-1", // Best model for call center audio
          keyterms_prompt: [
            // Add relevant keywords for your business context
            "mycar",
            "tyre",
            "auto",
            "rego",
            "Pirelli",
            "end of financial year sale",
            "tyre care plan",
            "quote",
            "email",
            "customer service",
            "call center",
            "agent",
            "customer",
          ],
          speaker_labels: true,
          speakers_expected: speakerCount || 2,
          summarization: true,
          summary_model: "conversational",
          summary_type: "paragraph",
          entity_detection: true,
          sentiment_analysis: true,
          filter_profanity: false, // Keep original content for analysis
          auto_highlights: true,
        }),
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

    // Poll for the transcription result with better timeout handling
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 120; // Increased for longer calls
    const pollInterval = 2000; // 2 seconds

    while (
      (status === "processing" || status === "queued") &&
      attempts < maxAttempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      attempts++;

      try {
        const statusResponse = await fetch(
          `https://api.assemblyai.com/v2/transcript/${id}`,
          {
            headers: {
              Authorization: apiKey,
            },
          }
        );

        if (!statusResponse.ok) {
          const errorData = await statusResponse.json();
          console.error("Status check error:", errorData);
          return NextResponse.json(
            { error: "Failed to check transcription status", details: errorData },
            { status: 500 }
          );
        }

        transcript = await statusResponse.json();
        status = transcript.status;
        
        // Log progress every 10 attempts
        if (attempts % 10 === 0) {
          console.log(`Transcription status: ${status}, attempt: ${attempts}/${maxAttempts}`);
        }
      } catch (error) {
        console.error("Error checking transcription status:", error);
        // Continue polling unless we've hit max attempts
        if (attempts >= maxAttempts - 5) {
          throw error;
        }
      }
    }

    if (status === "completed" && transcript) {
      console.log("Transcription completed successfully");

      // Map speaker labels to Agent and Customer
      if (transcript.utterances && transcript.utterances.length > 0) {
        transcript.utterances = transcript.utterances.map(
          (utterance: any) => ({
            ...utterance,
            speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
          })
        );
      }

      if (transcript.words && transcript.words.length > 0) {
        transcript.words = transcript.words.map(
          (word: any) => ({
            ...word,
            speakerRole: word.speaker === "A" ? "Agent" : "Customer",
          })
        );
      }

      // Perform topic categorization if we have utterances
      let categorization = null;
      if (transcript.utterances && transcript.utterances.length > 0) {
        categorization = await performTopicCategorization(transcript);
        
        if (categorization) {
          transcript.topic_categorization = {
            primary_topic: categorization.primary_category,
            all_topics: categorization.topic_categories,
            confidence: categorization.confidence,
          };
          console.log("Added topic categorization to transcript");
        } else {
          transcript.topic_categorization = {
            primary_topic: "Uncategorised",
            all_topics: ["Uncategorised"],
            confidence: 0,
          };
        }
      }

      // Save to Supabase if we have call data
      try {
        if (callData) {
          console.log("Saving transcription to Supabase...");
          await saveToSupabase(callData, transcript, categorization);
          console.log("Successfully saved to Supabase");
        } else {
          console.log("No call data provided, skipping Supabase save");
        }
      } catch (supabaseError) {
        console.error("Failed to save to Supabase:", supabaseError);
        // Don't fail the entire request if Supabase save fails
        // The transcription was successful and can be returned
      }

      return NextResponse.json({
        ...transcript,
        status: "completed",
        // Include call data in response if available
        call_data: callData || null,
      });

    } else if (status === "error") {
      console.error("Transcription failed with error:", transcript?.error);
      return NextResponse.json(
        {
          error: `Transcription failed: ${transcript?.error || "Unknown error"}`,
          status: "error",
        },
        { status: 500 }
      );
    } else if (attempts >= maxAttempts) {
      console.error("Transcription timed out after", attempts, "attempts");
      return NextResponse.json(
        {
          error: "Transcription timed out. The file might be too large or the service is busy.",
          status: "timeout",
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