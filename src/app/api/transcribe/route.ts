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
 * Simplified function to get audio from SFTP using HTTP endpoint
 * Optimized for Linux server environment
 */
async function getAudioFromSFTP(sftpFilename: string): Promise<Blob> {
  console.log("Fetching SFTP file:", sftpFilename);

  // Determine the correct internal URL for server-to-server communication
  const getInternalUrl = () => {
    // For production Linux server, try multiple approaches
    const possibleUrls = [
      // Try localhost first (best for internal server calls)
      `http://localhost:${process.env.PORT || 3000}`,
      // Fallback to 127.0.0.1
      `http://127.0.0.1:${process.env.PORT || 3000}`,
      // If environment variables are set
      process.env.NEXTAUTH_URL,
      process.env.NEXT_PUBLIC_SERVER_URL,
      // Network IP as last resort (though usually not needed for internal calls)
      process.env.NETWORK_URL || 'http://192.168.40.101:3000'
    ].filter(Boolean);

    return possibleUrls[0];
  };

  const baseUrl = getInternalUrl();
  const downloadUrl = `${baseUrl}/api/sftp/download?filename=${encodeURIComponent(sftpFilename)}`;
  
  console.log("Internal download URL:", downloadUrl);

  try {
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'TranscriptionService/1.0',
        'Host': 'localhost', // Help with internal routing
        'Connection': 'close', // Prevent keep-alive issues
      },
      // Add timeout to prevent hanging
      signal: AbortSignal.timeout(30000), // 30 seconds
    });
    
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

    const audioBlob = await response.blob();
    
    console.log("Successfully retrieved audio blob:", {
      size: audioBlob.size,
      type: audioBlob.type,
      sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2)
    });

    // Basic validation
    if (audioBlob.size === 0) {
      throw new Error("Audio file is empty");
    }

    if (audioBlob.size < 100) {
      throw new Error(`Audio file too small: ${audioBlob.size} bytes`);
    }

    // Check for reasonable file size (max 500MB)
    const maxSizeMB = 500;
    if (audioBlob.size > maxSizeMB * 1024 * 1024) {
      throw new Error(`Audio file too large: ${(audioBlob.size / (1024 * 1024)).toFixed(2)}MB (max: ${maxSizeMB}MB)`);
    }

    return audioBlob;

  } catch (error) {
    console.error("Error fetching SFTP file:", error);
    
    // Provide more helpful error context
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error("SFTP download timed out - file might be too large or server is busy");
    }
    
    throw new Error(`Failed to download audio file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Simplified function to upload audio to AssemblyAI
 */
async function uploadToAssemblyAI(audioBlob: Blob, apiKey: string, originalFilename?: string): Promise<string> {
  console.log("Uploading audio to AssemblyAI:", {
    size: audioBlob.size,
    sizeInMB: (audioBlob.size / (1024 * 1024)).toFixed(2),
    originalFilename
  });

  // Create form data with minimal processing
  const formData = new FormData();
  
  // Use original filename if available, otherwise default to audio.wav
  const filename = originalFilename ? originalFilename.split('/').pop() : 'audio.wav';
  
  // Append the blob directly without modification
  formData.append("file", audioBlob, filename);

  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: apiKey,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    console.error("AssemblyAI upload error:", errorData);
    throw new Error(`Failed to upload to AssemblyAI: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
  }

  const uploadData = await uploadResponse.json();
  console.log("Upload successful. Upload URL:", uploadData.upload_url);
  return uploadData.upload_url;
}

/**
 * Helper function to perform topic categorization
 */
async function performTopicCategorization(transcriptData: any) {
  try {
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

    console.log("Sending transcript for categorization");

    const topicResponse = await fetch(`${serverUrl}/api/openAI/categorise`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transcript: transcriptData }),
    });

    if (!topicResponse.ok) {
      console.error("Topic categorization failed:", topicResponse.status);
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
    }

    return null;
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
        
        // Get audio blob from SFTP
        const audioBlob = await getAudioFromSFTP(sftpFilename);
        
        // Upload directly to AssemblyAI
        uploadUrl = await uploadToAssemblyAI(audioBlob, apiKey, sftpFilename);
        
      } else if (audioUrl) {
        console.log("Processing audio URL:", audioUrl);
        
        // For URL-based audio, we can pass the URL directly to AssemblyAI
        // if it's publicly accessible, otherwise download and upload
        if (audioUrl.startsWith('http')) {
          uploadUrl = audioUrl; // Use URL directly
        } else {
          // Local URL - need to download and upload
          const response = await fetch(audioUrl);
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
      
      return NextResponse.json(
        { 
          error: "Failed to process audio file",
          details: error instanceof Error ? error.message : "Unknown error",
          stage: "audio_processing"
        },
        { status: 500 }
      );
    }

    console.log("Submitting transcription request to AssemblyAI...");

    // Submit transcription request with optimized settings for call center audio
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
          speech_model: "best", // Use the best available model
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

    // Poll for transcription result
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 180; // 6 minutes with 2-second intervals
    const pollInterval = 2000;

    while ((status === "processing" || status === "queued") && attempts < maxAttempts) {
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
          console.error("Status check failed:", statusResponse.status);
          continue; // Try again
        }

        transcript = await statusResponse.json();
        status = transcript.status;
        
        // Log progress every 30 seconds
        if (attempts % 15 === 0) {
          console.log(`Transcription status: ${status}, attempt: ${attempts}/${maxAttempts}`);
        }
        
      } catch (error) {
        console.error("Error checking transcription status:", error);
        // Continue polling unless we're near the end
        if (attempts >= maxAttempts - 5) {
          throw error;
        }
      }
    }

    // Handle transcription results
    if (status === "completed" && transcript) {
      console.log("Transcription completed successfully");

      // Map speaker labels to Agent and Customer
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

      // Perform topic categorization
      let categorization = null;
      if (transcript.utterances && transcript.utterances.length > 0) {
        categorization = await performTopicCategorization(transcript);
        
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
      try {
        if (callData) {
          console.log("Saving transcription to Supabase...");
          await saveToSupabase(callData, transcript, categorization);
          console.log("Successfully saved to Supabase");
        }
      } catch (supabaseError) {
        console.error("Failed to save to Supabase:", supabaseError);
        // Don't fail the request if Supabase save fails
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
      
    } else if (attempts >= maxAttempts) {
      console.error("Transcription timed out");
      return NextResponse.json(
        {
          error: "Transcription timed out. The audio file might be too long or the service is busy.",
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