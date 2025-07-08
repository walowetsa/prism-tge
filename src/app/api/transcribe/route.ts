import { NextResponse } from "next/server";
// import { transcriptionExists, getTranscription, saveTranscription } from "@/lib/transcription-storage";

/**
 * Helper function to save transcription to Supabase
 * @param callId The unique identifier for the call
 * @param transcriptData The complete transcript data from AssemblyAI
 * @param transcriptText The extracted text from the transcription
 */

async function saveToSupabase(
  callId: string,
  // TODO: Fix Typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transcriptData: any,
  transcriptText: string
) {
  try {
    // Try different possible API route paths
    const serverUrl =
      process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

    // Try the most common paths for Next.js API routes
    const possiblePaths = [
      `${serverUrl}/api/supabase/save-transcription`, // Updated to correct path
      `${serverUrl}/api/supabase`,
      `${serverUrl}/api/supabase/route`,
      `${serverUrl}/api/transcriptions`,
    ];

    console.log(`Saving transcription to Supabase for call ID: ${callId}`);

    let lastError;

    for (const apiUrl of possiblePaths) {
      try {
        console.log(`Trying Supabase API URL: ${apiUrl}`);

        // Prepare the data payload with categorization info
        const payload = {
          contact_id: callId,
          recording_location: transcriptData.recording_location || "",
          transcript_text: transcriptText,
          queue_name: transcriptData.queue_name || null,
          agent_username: transcriptData.agent_username || "",
          initiation_timestamp:
            transcriptData.initiation_timestamp || new Date().toISOString(),
          speaker_data: transcriptData.utterances
            ? JSON.stringify(transcriptData.utterances)
            : null,
          sentiment_analysis: transcriptData.sentiment_analysis_results
            ? JSON.stringify(transcriptData.sentiment_analysis_results)
            : null,
          entities: transcriptData.entities
            ? JSON.stringify(transcriptData.entities)
            : null,
          disposition_title: transcriptData.disposition_title || null,
          call_summary: transcriptData.summary || null,
          campaign_name: transcriptData.campaign_name || null,
          campaign_id: transcriptData.campaign_id || null,
          customer_cli: transcriptData.customer_cli || null,
          agent_hold_time: transcriptData.agent_hold_time || null,
          total_hold_time: transcriptData.total_hold_time || null,
          time_in_queue: transcriptData.time_in_queue || null,
          call_duration: transcriptData.call_duration || null,
          // Add categorization data to correct columns
          categories: transcriptData.topic_categorization?.all_topics
            ? JSON.stringify(transcriptData.topic_categorization.all_topics)
            : null,
          primary_category:
            transcriptData.topic_categorization?.primary_topic || null,
        };

        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        console.log(`Response status for ${apiUrl}: ${response.status}`);

        if (response.status === 404) {
          console.log(`404 for ${apiUrl}, trying next path...`);
          continue; // Try the next path
        }

        if (!response.ok) {
          // Try to get the response as text first
          const responseText = await response.text();
          console.error(`Error response from ${apiUrl}:`, responseText);

          let errorData;
          try {
            errorData = JSON.parse(responseText);
          } catch {
            errorData = {
              error: "Non-JSON response received",
              status: response.status,
              responseText: responseText.substring(0, 500),
            };
          }

          throw new Error(
            `Supabase save failed: ${response.status} - ${
              errorData.error || "Unknown error"
            }`
          );
        }

        // Success!
        const result = await response.json();
        console.log(
          `Successfully saved to Supabase via ${apiUrl}:`,
          result.data?.id || result.data?.contact_id
        );
        return result.data;
      } catch (fetchError) {
        if (fetchError instanceof Error) {
          console.log(`Failed to use ${apiUrl}:`, fetchError.message);
        } else {
          console.log(`Failed to use ${apiUrl}:`, String(fetchError));
        }

        lastError = fetchError;
        continue;
      }
    }

    // If we get here, all paths failed
    throw lastError || new Error("All API paths failed");
  } catch (error) {
    console.error("Error saving to Supabase:", error);

    console.log(
      "Current working directory check - your API route should be at one of these locations:"
    );
    console.log(
      "- src/app/api/supabase/save-transcription/route.ts (App Router)"
    );
    console.log("- pages/api/supabase.ts (Pages Router)");
    console.log("- src/pages/api/supabase.ts (Pages Router with src)");

    return null;
  }
}

/**
 * Helper function to download a file from SFTP
 * @param sftpFilename The filename or path in the SFTP server
 * @returns An audio blob
 */
async function getSftpAudio(sftpFilename: string) {
  console.log("Handling SFTP file directly:", sftpFilename);

  // Create a server-side request to our own SFTP download API
  const serverUrl =
    process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
  const sftpApiUrl = `${serverUrl}/api/sftp/download?filename=${encodeURIComponent(
    sftpFilename
  )}`;

  console.log("Fetching SFTP file from:", sftpApiUrl);

  // Fetch the audio file directly from our SFTP API
  const audioResponse = await fetch(sftpApiUrl);
  if (!audioResponse.ok) {
    console.error("Failed to fetch SFTP file:", await audioResponse.text());
    throw new Error(`Failed to fetch SFTP file: ${audioResponse.status}`);
  }

  const audioBlob = await audioResponse.blob();
  console.log("Audio blob size (direct SFTP):", audioBlob.size);

  if (audioBlob.size === 0) {
    console.error("Retrieved audio file is empty");
    throw new Error("Retrieved audio file is empty");
  }

  return audioBlob;
}

/**
 * Helper function to handle audio files from a URL
 * @param audioUrl The URL of the audio file
 * @returns An audio blob
 */
async function getAudioFromUrl(audioUrl: string) {
  // Check if this is a local file path
  const isLocalPath = audioUrl.startsWith("/api/");

  if (isLocalPath) {
    // For local files, we need to get the actual audio file
    const serverUrl =
      process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
    const fullAudioUrl = `${serverUrl}${audioUrl}`;

    console.log("Fetching audio from local path:", fullAudioUrl);

    // Fetch the audio file
    const audioResponse = await fetch(fullAudioUrl);
    if (!audioResponse.ok) {
      console.error("Failed to fetch audio file:", await audioResponse.text());
      throw new Error(`Failed to fetch audio file: ${audioResponse.status}`);
    }

    const audioBlob = await audioResponse.blob();
    console.log("Audio blob size from local path:", audioBlob.size);

    if (audioBlob.size === 0) {
      throw new Error("Retrieved audio file is empty");
    }

    return audioBlob;
  } else {
    // If it's an external URL, just return the URL for AssemblyAI to fetch directly
    console.log("Using external audio URL:", audioUrl);
    return audioUrl;
  }
}

/**
 * Helper function to upload audio to AssemblyAI
 * @param audioBlob The audio blob or URL to upload
 * @param apiKey The AssemblyAI API key
 * @returns The upload URL for transcription
 */
async function uploadToAssemblyAI(audioBlob: Blob | string, apiKey: string) {
  if (typeof audioBlob === "string") {
    return audioBlob;
  }

  console.log("Uploading blob to AssemblyAI...");
  const uploadFormData = new FormData();
  uploadFormData.append("file", audioBlob, "audio.mp3");

  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: apiKey,
    },
    body: uploadFormData,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    console.error("Upload error:", errorData);
    throw new Error(
      `Failed to upload audio to AssemblyAI: ${JSON.stringify(errorData)}`
    );
  }

  const uploadData = await uploadResponse.json();
  console.log("Upload successful. Upload URL:", uploadData.upload_url);
  return uploadData.upload_url;
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
    } = body;

    // Check if we have either an audioUrl or a direct SFTP file
    if (!audioUrl && !isDirectSftpFile) {
      return NextResponse.json(
        { error: "Either Audio URL or SFTP filename is required" },
        { status: 400 }
      );
    }

    if (!filename) {
      return NextResponse.json(
        { error: "Filename is required for caching" },
        { status: 400 }
      );
    }

    // Check if we already have the transcription saved
    // if (transcriptionExists(filename)) {
    //   console.log(`Using cached transcription for ${filename}`);
    //   const cachedTranscription = getTranscription(filename);
    //   return NextResponse.json(cachedTranscription);
    // }

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
        // Get audio from SFTP
        const audioBlob = await getSftpAudio(sftpFilename);
        fileToTranscribe = await uploadToAssemblyAI(audioBlob, apiKey);
      } else if (audioUrl) {
        // Get audio from URL (local or external)
        const audioSource = await getAudioFromUrl(audioUrl);
        fileToTranscribe = await uploadToAssemblyAI(audioSource, apiKey);
      }
    } catch (error) {
      console.error("Error getting or uploading audio:", error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Error processing audio file" },
        { status: 500 }
      );
    }

    console.log(
      "Submitting transcription request with file:",
      fileToTranscribe
    );

    // Submit the transcription request to AssemblyAI
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
          speech_model: "slam-1",
          keyterms_prompt: [
            "mycar",
            "tyre",
            "auto",
            "rego",
            "speaking",
            "you're",
            "Pirelli",
            "end",
            "of",
            "financial",
            "year",
            "sale",
            "care",
            "plan",
            "end of financial year sale",
            "tyre care plan",
            "quote",
            "email",
          ],
          speaker_labels: true,
          speakers_expected: speakerCount || 2,
          summarization: true,
          summary_model: "conversational",
          summary_type: "paragraph",
          entity_detection: true,
          sentiment_analysis: true,
        }),
      }
    );

    if (!transcriptResponse.ok) {
      const errorData = await transcriptResponse.json();
      console.error("Transcription request error:", errorData);
      return NextResponse.json(
        { error: "Failed to initiate transcription", details: errorData },
        { status: 500 }
      );
    }

    const { id } = await transcriptResponse.json();
    console.log(`Transcription job created with ID: ${id}`);

    // Poll for the transcription result
    let transcript;
    let status = "processing";
    let attempts = 0;
    const maxAttempts = 90; // Increased to 90 as diarization can take longer

    while (
      (status === "processing" || status === "queued") &&
      attempts < maxAttempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;

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
      console.log(`Transcription status: ${status}, attempt: ${attempts}`);
    }

    if (status === "completed") {
      // Map speaker labels to Agent and Customer
      if (transcript.utterances && transcript.utterances.length > 0) {
        transcript.utterances = transcript.utterances.map(
          (utterance: { speaker: string }) => ({
            ...utterance,
            speakerRole: utterance.speaker === "A" ? "Agent" : "Customer",
          })
        );
      }

      if (transcript.words && transcript.words.length > 0) {
        transcript.words = transcript.words.map(
          (word: { speaker: string }) => ({
            ...word,
            speakerRole: word.speaker === "A" ? "Agent" : "Customer",
          })
        );
      }

      // Call our custom topic categorization endpoint
      try {
        const serverUrl =
          process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

        console.log("Sending transcript for categorization:", {
          hasUtterances: !!(
            transcript.utterances && transcript.utterances.length > 0
          ),
          utteranceCount: transcript.utterances?.length || 0,
          transcriptLength: transcript.text?.length || 0,
        });

        const topicResponse = await fetch(
          `${serverUrl}/api/openAI/categorise`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ transcript }),
          }
        );

        if (topicResponse.ok) {
          const topicData = await topicResponse.json();
          console.log("Topic categorization received:", topicData);

          // Check if we got valid categorisation data
          if (
            topicData.topic_categories &&
            topicData.topic_categories.length > 0
          ) {
            // Add the topic categorisation to the transcript object
            transcript.topic_categorization = {
              // Primary topic is the first in the array
              primary_topic: topicData.primary_category,
              // Store all topics for more detailed analysis
              all_topics: topicData.topic_categories,
              // Keep confidence for compatibility
              confidence: topicData.confidence || 1.0,
            };

            console.log(
              "Added valid topic categorization to transcript:",
              transcript.topic_categorization
            );
          } else {
            console.warn(
              "Categorization API returned invalid data:",
              topicData
            );
            // Add a default topic in case of invalid response
            transcript.topic_categorization = {
              primary_topic: "Uncategorised",
              all_topics: ["Uncategorised"],
              confidence: 0,
            };
          }
        } else {
          const errorText = await topicResponse.text();
          console.error(
            "Failed to get topic categorization, status:",
            topicResponse.status,
            "response:",
            errorText
          );
          // Add a default topic in case of failure
          transcript.topic_categorization = {
            primary_topic: "Uncategorised",
            all_topics: ["Uncategorised"],
            confidence: 0,
          };
        }
      } catch (topicError) {
        console.error("Error in topic categorization:", topicError);
        transcript.topic_categorization = {
          primary_topic: "Uncategorised",
          all_topics: ["Uncategorised"],
          confidence: 0,
        };
      }

      // Save the transcription for future use (local caching)
      // saveTranscription(filename, transcript);
      // console.log(`Saved transcription for ${filename}`);

      // Save to Supabase database with categorization data
      try {
        // Use filename as call_id, or you can modify this to use a different identifier
        const callId = filename.replace(/\.[^/.]+$/, ""); // Remove file extension
        const transcriptText = transcript.text || "";

        console.log(
          "Saving to Supabase with categorization:",
          transcript.topic_categorization
        );
        await saveToSupabase(callId, transcript, transcriptText);
      } catch (supabaseError) {
        console.error(
          "Failed to save to Supabase, but continuing:",
          supabaseError
        );
        // We don't return an error here because the transcription was successful
        // The local cache will still work even if Supabase fails
      }

      return NextResponse.json(transcript);
    } else if (attempts >= maxAttempts) {
      return NextResponse.json(
        {
          error:
            "Transcription timed out. The file might be too large or the service is busy.",
        },
        { status: 504 }
      );
    } else {
      return NextResponse.json(
        {
          error: `Transcription failed with status: ${status}`,
          details: transcript?.error || "Unknown error",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error in transcribe API route:", error);
    return NextResponse.json(
      { error: "Internal server error", message: error instanceof Error ? error.message : "Unknown Error" },
      { status: 500 }
    );
  }
}
