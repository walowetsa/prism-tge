/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";

interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

interface CallLog {
  contact_id: string;
  agent_username: string;
  recording_location: string;
  initiation_timestamp: string;
  total_call_time: {
    minutes: number;
    seconds: number;
  };
  campaign_name: string;
  campaign_id: number;
  customer_cli: string;
  agent_hold_time: number;
  total_hold_time: number;
  time_in_queue: number;
  queue_name: string;
  disposition_title: string;
  existsInSupabase?: boolean;
  transcriptionStatus?: "Transcribed" | "Pending Transcription" | "Failed";
  transcriptionProgress?: number;
  transcriptionError?: string;
}

type SortField = 'agent_username' | 'initiation_timestamp' | 'total_call_time' | 'queue_name' | 'disposition_title';
type SortDirection = 'asc' | 'desc';

const ITEMS_PER_PAGE = 100;

const CallLogDisplay = ({
  selectedDateRange,
  checkSupabase = true,
}: {
  selectedDateRange: DateRange | null;
  checkSupabase?: boolean;
}) => {
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>('initiation_timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  // FIXED: Transcription state for call recordings
  const [transcriptionQueue, setTranscriptionQueue] = useState<string[]>([]);
  const [activeTranscriptions, setActiveTranscriptions] = useState<Set<string>>(new Set());
  const [failedTranscriptions, setFailedTranscriptions] = useState<Set<string>>(new Set());
  const maxConcurrentTranscriptions = 1; // Keep at 2 for server stability
  
  const progressIntervals = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const transcriptionControllers = useRef<Map<string, AbortController>>(new Map());

  // Get unique agents from call logs
  const uniqueAgents = useMemo(() => {
    const agents = Array.from(new Set(callLogs.map(log => log.agent_username)))
      .filter(agent => agent && agent.trim() !== "")
      .sort();
    return agents;
  }, [callLogs]);

  // Filter and sort call logs
  const filteredAndSortedCallLogs = useMemo(() => {
    let filtered = callLogs;
    
    if (selectedAgent !== "all") {
      filtered = callLogs.filter(log => log.agent_username === selectedAgent);
    }
    
    return filtered.sort((a, b) => {
      let aValue: any, bValue: any;
      
      switch (sortField) {
        case 'agent_username':
          aValue = a.agent_username || '';
          bValue = b.agent_username || '';
          break;
        case 'initiation_timestamp':
          aValue = new Date(a.initiation_timestamp).getTime();
          bValue = new Date(b.initiation_timestamp).getTime();
          break;
        case 'total_call_time':
          aValue = (a.total_call_time?.minutes || 0) * 60 + (a.total_call_time?.seconds || 0);
          bValue = (b.total_call_time?.minutes || 0) * 60 + (b.total_call_time?.seconds || 0);
          break;
        case 'queue_name':
          aValue = a.queue_name || '';
          bValue = b.queue_name || '';
          break;
        case 'disposition_title':
          aValue = a.disposition_title || '';
          bValue = b.disposition_title || '';
          break;
        default:
          return 0;
      }
      
      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [callLogs, selectedAgent, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedCallLogs.length / ITEMS_PER_PAGE);
  const paginatedCallLogs = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return filteredAndSortedCallLogs.slice(startIndex, endIndex);
  }, [filteredAndSortedCallLogs, currentPage]);

  // Cleanup function for transcription resources
  const cleanupTranscription = useCallback((contactId: string) => {
    const interval = progressIntervals.current.get(contactId);
    if (interval) {
      clearInterval(interval);
      progressIntervals.current.delete(contactId);
    }
    
    const controller = transcriptionControllers.current.get(contactId);
    if (controller) {
      controller.abort();
      transcriptionControllers.current.delete(contactId);
    }
    
    setActiveTranscriptions(prev => {
      const newSet = new Set(prev);
      newSet.delete(contactId);
      return newSet;
    });
  }, []);

  // Cleanup all transcriptions on unmount
  useEffect(() => {
    return () => {
      progressIntervals.current.forEach(interval => clearInterval(interval));
      transcriptionControllers.current.forEach(controller => controller.abort());
      progressIntervals.current.clear();
      transcriptionControllers.current.clear();
    };
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // FIXED: Audio download for call recordings
  const handleAudioDownload = async (log: CallLog) => {
    if (!log.recording_location) {
      alert("No audio file available for this call");
      return;
    }

    const contactId = log.contact_id;
    
    if (downloadingAudio.includes(contactId)) return;

    setDownloadingAudio(prev => [...prev, contactId]);

    try {
      console.log(`🎵 Downloading call recording for: ${contactId}`);

      const downloadUrl = `/api/sftp/download?filename=${encodeURIComponent(log.recording_location)}`;
      
      // FIXED: Realistic timeout for call recordings (3 minutes)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes

      const response = await fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Download failed: ${response.status} - ${errorText}`);
      }

      const blob = await response.blob();
      console.log(`📦 Downloaded: ${blob.size} bytes, type: ${blob.type}`);

      if (blob.size === 0) {
        throw new Error("Downloaded file is empty");
      }

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = log.recording_location.split('/').pop() || `call_${contactId}.wav`;
      
      document.body.appendChild(a);
      a.click();
      
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      console.log(`✅ Download completed for: ${contactId}`);

    } catch (error) {
      console.error(`❌ Download error for ${contactId}:`, error);
      
      if (error instanceof Error && error.name === 'AbortError') {
        alert('Download timed out after 3 minutes. Call recording may be large or server is slow.');
      } else {
        alert(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } finally {
      setDownloadingAudio(prev => prev.filter(id => id !== contactId));
    }
  };

  // Reset filters when data changes
  useEffect(() => {
    setSelectedAgent("all");
    setCurrentPage(1);
  }, [selectedDateRange]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedAgent, sortField, sortDirection]);

  // Get transcription status
  const getTranscriptionStatus = (log: CallLog) => {
    if (checkSupabase && log.existsInSupabase) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <div className="w-2 h-2 bg-green-500 rounded-full mr-1"></div>
          Transcribed
        </span>
      );
    } else if (activeTranscriptions.has(log.contact_id)) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          <div className="w-2 h-2 bg-yellow-500 rounded-full mr-1 animate-pulse"></div>
          Processing
          {log.transcriptionProgress && (
            <span className="ml-1">({log.transcriptionProgress}%)</span>
          )}
        </span>
      );
    } else if (log.transcriptionStatus === "Failed") {
      return (
        <span 
          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 cursor-help"
          title={log.transcriptionError || "Transcription failed"}
        >
          <div className="w-2 h-2 bg-red-500 rounded-full mr-1"></div>
          Failed
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
          <div className="w-2 h-2 bg-gray-500 rounded-full mr-1"></div>
          Pending
        </span>
      );
    }
  };

  // Helper to safely parse API responses
  const parseApiResponse = async (response: Response) => {
    const contentType = response.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
      try {
        return await response.json();
      } catch (jsonError) {
        const text = await response.text();
        throw new Error(`Invalid JSON response: ${text.substring(0, 200)}...`);
      }
    } else {
      const text = await response.text();
      
      if (text.includes('504') || text.includes('Gateway Time-out')) {
        throw new Error("Request timed out. Call recording processing takes time - please try again.");
      } else if (text.includes('502') || text.includes('Bad Gateway')) {
        throw new Error("Server error. Please try again in a moment.");
      } else {
        throw new Error(`Server error. Status: ${response.status}`);
      }
    }
  };

  // FIXED: Transcription for call recordings
  const initiateTranscription = useCallback(async (log: CallLog) => {
    if (!log.recording_location) return false;

    const contactId = log.contact_id;
    
    // FIXED: Realistic timeout for call recordings (8 minutes)
    const controller = new AbortController();
    transcriptionControllers.current.set(contactId, controller);
    
    const timeoutId = setTimeout(() => {
      console.log(`⏰ Aborting transcription for ${contactId} - 8 minute timeout`);
      controller.abort();
    }, 8 * 60 * 1000);

    try {
      console.log(`🚀 Starting transcription for call recording: ${contactId}`);
      
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === contactId
            ? {
                ...l,
                transcriptionStatus: "Pending Transcription",
                transcriptionProgress: 0,
                transcriptionError: undefined,
              }
            : l
        )
      );

      const fullPath = log.recording_location;
      const filename = fullPath.split("/").pop();
      
      if (!filename) {
        throw new Error("Could not extract filename");
      }

      console.log(`📁 Processing call recording: ${filename}`);

      // FIXED: Realistic progress updates for call recordings
      const progressInterval = setInterval(() => {
        setCallLogs((prevLogs) =>
          prevLogs.map((l) => {
            if (l.contact_id === contactId && l.transcriptionStatus === "Pending Transcription") {
              const currentProgress = l.transcriptionProgress || 0;
              const newProgress = Math.min(85, currentProgress + 2); // Slower, more realistic progress
              return { ...l, transcriptionProgress: newProgress };
            }
            return l;
          })
        );
      }, 5000); // Every 5 seconds

      progressIntervals.current.set(contactId, progressInterval);

      // Make transcription request
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isDirectSftpFile: true,
          sftpFilename: fullPath,
          filename: filename,
          speakerCount: 2,
          callData: {
            contact_id: log.contact_id,
            agent_username: log.agent_username,
            recording_location: log.recording_location,
            initiation_timestamp: log.initiation_timestamp,
            total_call_time: log.total_call_time,
            campaign_name: log.campaign_name,
            campaign_id: log.campaign_id,
            customer_cli: log.customer_cli,
            agent_hold_time: log.agent_hold_time,
            total_hold_time: log.total_hold_time,
            time_in_queue: log.time_in_queue,
            queue_name: log.queue_name,
            disposition_title: log.disposition_title,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorData;
        try {
          errorData = await parseApiResponse(response);
        } catch (parseError) {
          throw new Error(`HTTP ${response.status}: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
        
        throw new Error(errorData.error || `HTTP ${response.status}: Transcription failed`);
      }

      const transcriptionData = await parseApiResponse(response);
      
      const hasValidTranscript = transcriptionData && 
        transcriptionData.status === "completed" &&
        transcriptionData.text && 
        transcriptionData.text.trim().length > 0;

      console.log(`✅ Transcription completed for ${contactId}:`, {
        status: transcriptionData.status,
        hasText: hasValidTranscript
      });

      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === contactId
            ? {
                ...l,
                transcriptionStatus: "Transcribed",
                transcriptionProgress: 100,
                existsInSupabase: true,
                transcriptionError: undefined,
              }
            : l
        )
      );

      return true;
    } catch (error) {
      clearTimeout(timeoutId);
      console.error(`💥 Transcription error for ${contactId}:`, error);

      let errorMessage = "Unknown error";
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          errorMessage = "Transcription timed out after 8 minutes. Call recording may be very large.";
        } else if (error.message.includes('504') || error.message.includes('timeout')) {
          errorMessage = "Request timed out. Call recording processing takes time - please try again.";
        } else {
          errorMessage = error.message;
        }
      }
      
      setCallLogs((prevLogs) =>
        prevLogs.map((l) =>
          l.contact_id === contactId
            ? {
                ...l,
                transcriptionStatus: "Failed",
                transcriptionProgress: undefined,
                transcriptionError: errorMessage,
              }
            : l
        )
      );

      setFailedTranscriptions(prev => new Set(prev).add(contactId));
      return false;
    } finally {
      cleanupTranscription(contactId);
    }
  }, [cleanupTranscription]);

  // Queue management
  const queueTranscription = useCallback((logId: string) => {
    setTranscriptionQueue((prev) => {
      if (prev.includes(logId) || 
          activeTranscriptions.has(logId) || 
          failedTranscriptions.has(logId)) {
        return prev;
      }
      return [...prev, logId];
    });
  }, [activeTranscriptions, failedTranscriptions]);

  // Process queue
  useEffect(() => {
    const processQueue = async () => {
      if (transcriptionQueue.length === 0) return;

      const availableSlots = maxConcurrentTranscriptions - activeTranscriptions.size;
      if (availableSlots <= 0) return;

      const logsToProcess = transcriptionQueue.slice(0, availableSlots);

      setTranscriptionQueue((prev) =>
        prev.filter((id) => !logsToProcess.includes(id))
      );
      
      setActiveTranscriptions((prev) => {
        const newSet = new Set(prev);
        logsToProcess.forEach(id => newSet.add(id));
        return newSet;
      });

      const transcriptionPromises = logsToProcess.map(async (logId) => {
        const logToTranscribe = callLogs.find(log => log.contact_id === logId);

        if (!logToTranscribe || !logToTranscribe.recording_location) {
          setActiveTranscriptions(prev => {
            const newSet = new Set(prev);
            newSet.delete(logId);
            return newSet;
          });
          return;
        }

        try {
          await initiateTranscription(logToTranscribe);
        } catch (error) {
          console.error(`Error processing ${logId}:`, error);
        }
      });

      await Promise.allSettled(transcriptionPromises);
    };

    processQueue();
  }, [transcriptionQueue, activeTranscriptions, callLogs, initiateTranscription, maxConcurrentTranscriptions]);

  // Fetch call logs
  useEffect(() => {
    const fetchCallLogs = async () => {
      if (!selectedDateRange) return;

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          startDate: selectedDateRange.start.toISOString(),
          endDate: selectedDateRange.end.toISOString(),
          checkSupabase: checkSupabase.toString(),
        });

        const response = await fetch(`/api/get-call-logs?${params}`);
        const data = await response.json();

        if (data.success) {
          const logsWithTranscriptionStatus = data.data.map((log: CallLog) => ({
            ...log,
            transcriptionStatus: log.existsInSupabase ? "Transcribed" : "Pending Transcription",
          }));

          setCallLogs(logsWithTranscriptionStatus);
          
          // Reset transcription state
          setTranscriptionQueue([]);
          setActiveTranscriptions(new Set());
          setFailedTranscriptions(new Set());
          
          // Clear intervals and controllers
          progressIntervals.current.forEach(interval => clearInterval(interval));
          transcriptionControllers.current.forEach(controller => controller.abort());
          progressIntervals.current.clear();
          transcriptionControllers.current.clear();
        } else {
          setError(data.error || "Failed to fetch call logs");
        }
      } catch (err) {
        setError("Network error occurred while fetching call logs");
        console.error("Error fetching call logs:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchCallLogs();
  }, [selectedDateRange, checkSupabase]);

  // FIXED: Conservative auto-queue for call recordings
  useEffect(() => {
    if (!loading && callLogs.length > 0) {
      const maxAutoQueue = 5; // Conservative for call recordings
      let queued = 0;

      const totalInProgress = transcriptionQueue.length + activeTranscriptions.size;
      
      if (totalInProgress < maxAutoQueue) {
        paginatedCallLogs.forEach((log) => {
          if (
            log.recording_location &&
            log.transcriptionStatus === "Pending Transcription" &&
            log.existsInSupabase === false &&
            !transcriptionQueue.includes(log.contact_id) &&
            !activeTranscriptions.has(log.contact_id) &&
            !failedTranscriptions.has(log.contact_id) &&
            queued < (maxAutoQueue - totalInProgress)
          ) {
            console.log(`📋 Auto-queueing call recording: ${log.contact_id}`);
            queueTranscription(log.contact_id);
            queued++;
          }
        });
      }
    }
  }, [paginatedCallLogs, loading, queueTranscription, transcriptionQueue, activeTranscriptions, failedTranscriptions]);

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatCallDuration = (totalCallTime: { minutes: number; seconds: number }) => {
    if (!totalCallTime) return "N/A";
    const { minutes = 0, seconds = 0 } = totalCallTime;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '↕️';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  // Retry failed transcriptions
  const retryTranscription = useCallback((contactId: string) => {
    setFailedTranscriptions(prev => {
      const newSet = new Set(prev);
      newSet.delete(contactId);
      return newSet;
    });
    
    setCallLogs(prevLogs =>
      prevLogs.map(l =>
        l.contact_id === contactId
          ? {
              ...l,
              transcriptionStatus: "Pending Transcription",
              transcriptionProgress: 0,
              transcriptionError: undefined,
            }
          : l
      )
    );
    
    queueTranscription(contactId);
  }, [queueTranscription]);

  return (
    <div className="flex-1 border-2 p-2 rounded border-border bg-bg-secondary">
      <div className="flex items-center justify-between mb-4">
        <h5 className="text-[#4ecca3]">Call Logs</h5>
        <Link
          href="/tge/overview"
          className="px-3 py-2 bg-[#4ecca3] text-[#0a101b] rounded-lg hover:bg-[#3bb891] transition-colors text-sm font-medium"
        >
          View All Transcribed Calls
        </Link>
      </div>

      {!selectedDateRange ? (
        <div>Please Select A Date Range</div>
      ) : (
        <div>
          <div className="mb-4">
            <h6 className="text-sm text-white">
              Call Data for {selectedDateRange.label}
            </h6>
          </div>

          {/* Agent Filter */}
          {uniqueAgents.length > 0 && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-white mb-2">
                Filter by Agent:
              </label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="px-3 py-2 bg-bg-primary border border-border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#4ecca3] focus:border-transparent"
              >
                <option value="all">All Agents ({callLogs.length} calls)</option>
                {uniqueAgents.map((agent) => {
                  const agentCallCount = callLogs.filter(log => log.agent_username === agent).length;
                  return (
                    <option key={agent} value={agent}>
                      {agent} ({agentCallCount} calls)
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Queue status */}
          {(transcriptionQueue.length > 0 || activeTranscriptions.size > 0 || failedTranscriptions.size > 0) && (
            <div className="mb-4 p-3 bg-bg-primary border border-border rounded-lg">
              <div className="text-sm text-[#4ecca3] font-medium">
                Transcription Status: {activeTranscriptions.size} active, {transcriptionQueue.length} queued
                {failedTranscriptions.size > 0 && (
                  <span className="text-red-400 ml-2">({failedTranscriptions.size} failed)</span>
                )}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                📞 Processing call recordings - may take several minutes per file
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center p-8">
              <div className="text-gray-500">Loading call logs...</div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error}
            </div>
          )}

          {!loading && !error && (
            <div>
              <div className="mb-4 flex justify-between items-center">
                <div className="text-sm text-white">
                  {selectedAgent === "all" 
                    ? `Found ${filteredAndSortedCallLogs.length} call(s) - Page ${currentPage} of ${totalPages} (showing ${paginatedCallLogs.length} records)` 
                    : `Showing ${filteredAndSortedCallLogs.length} call(s) for ${selectedAgent} - Page ${currentPage} of ${totalPages} (${paginatedCallLogs.length} records) - ${callLogs.length} total calls`
                  }
                </div>
                
                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      First
                    </button>
                    <button
                      onClick={() => setCurrentPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      Previous
                    </button>
                    <span className="text-xs text-white px-2">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      Next
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      className="px-2 py-1 text-xs bg-bg-primary border border-border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 text-white"
                    >
                      Last
                    </button>
                  </div>
                )}
              </div>

              {filteredAndSortedCallLogs.length === 0 ? (
                <div className="text-gray-500 p-4 text-center">
                  {selectedAgent === "all" 
                    ? "No call logs found for this date range"
                    : `No call logs found for agent ${selectedAgent} in this date range`
                  }
                </div>
              ) : (
                <div className="overflow-hidden border border-border rounded-lg">
                  <div className="overflow-x-auto max-h-[calc(100vh-420px)]">
                    <table className="min-w-full bg-bg-primary">
                      <thead className="bg-bg-secondary border-b border-border sticky top-0 z-10">
                        <tr>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('agent_username')}
                          >
                            Agent {getSortIcon('agent_username')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('initiation_timestamp')}
                          >
                            Call Date/Time {getSortIcon('initiation_timestamp')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('total_call_time')}
                          >
                            Duration {getSortIcon('total_call_time')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('queue_name')}
                          >
                            Queue {getSortIcon('queue_name')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('disposition_title')}
                          >
                            Disposition {getSortIcon('disposition_title')}
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider">
                            Transcription Status
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {paginatedCallLogs.map((log, index) => (
                          <tr 
                            key={log.contact_id || index}
                            className="hover:bg-gray-800 transition-colors"
                          >
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {log.agent_username}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {formatTimestamp(log.initiation_timestamp)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {formatCallDuration(log.total_call_time)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {log.queue_name || "N/A"}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {log.disposition_title || "N/A"}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              {getTranscriptionStatus(log)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              <div className="flex items-center space-x-2">
                                <Link 
                                  href={`/tge/${log.contact_id}`}
                                  className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-[#4ecca3] hover:bg-[#3bb891] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4ecca3] transition-colors"
                                >
                                  View Details
                                </Link>
                                
                                {log.transcriptionStatus === "Failed" && (
                                  <button
                                    onClick={() => retryTranscription(log.contact_id)}
                                    className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 transition-colors"
                                    title={`Retry transcription (Error: ${log.transcriptionError})`}
                                  >
                                    Retry
                                  </button>
                                )}
                                
                                {log.recording_location && (
                                  <button
                                    onClick={() => handleAudioDownload(log)}
                                    disabled={downloadingAudio.includes(log.contact_id)}
                                    className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                                    title="Download audio file"
                                  >
                                    {downloadingAudio.includes(log.contact_id) ? (
                                      <>
                                        <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Downloading...
                                      </>
                                    ) : (
                                      <>
                                        <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                        Audio
                                      </>
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CallLogDisplay;