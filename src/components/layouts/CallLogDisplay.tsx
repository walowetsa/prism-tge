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
  transcriptionStatus?: "Transcribed" | "Pending Transcription" | "Failed" | "Processing";
  transcriptionProgress?: number;
  transcriptionError?: string;
}

interface ProcessingError {
  contact_id: string;
  error: string;
}

type SortField = 'agent_username' | 'initiation_timestamp' | 'total_call_time' | 'queue_name' | 'disposition_title';
type SortDirection = 'asc' | 'desc';

const ITEMS_PER_PAGE = 100;
const BATCH_SIZE = 5;

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
  const [processing, setProcessing] = useState(false);
  const [processingErrors, setProcessingErrors] = useState<ProcessingError[]>([]);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalToProcess, setTotalToProcess] = useState(0);
  
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>('initiation_timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  const processingRef = useRef(false);

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

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Audio download function (unchanged from original)
  const handleAudioDownload = async (log: CallLog) => {
    if (!log.recording_location) {
      alert("No audio file available for this call");
      return;
    }

    const contactId = log.contact_id;
    
    if (downloadingAudio.includes(contactId)) return;

    setDownloadingAudio(prev => [...prev, contactId]);

    try {
      console.log(`🎵 Downloading call recording: ${contactId}`);

      const downloadUrl = `/api/sftp/download?filename=${encodeURIComponent(log.recording_location)}`;
      
      const response = await fetch(downloadUrl);

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
      alert(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    } else if (log.transcriptionStatus === "Processing") {
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

  // Process transcriptions in batches of 5
  const processBatch = async (callsToProcess: CallLog[]) => {
    if (callsToProcess.length === 0) return [];

    const batchToProcess = callsToProcess.slice(0, BATCH_SIZE);
    const remainingAfterBatch = callsToProcess.slice(BATCH_SIZE);
    const contactIds = batchToProcess.map(call => call.contact_id);
    
    try {
      console.log(`🚀 Processing batch of ${contactIds.length} calls (${remainingAfterBatch.length} remaining):`, contactIds);

      // Mark calls as processing
      setCallLogs(prevLogs => 
        prevLogs.map(log => 
          contactIds.includes(log.contact_id) 
            ? { ...log, transcriptionStatus: "Processing" as const }
            : log
        )
      );

      // Create request with longer timeout (20 minutes for batch of 5)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20 * 60 * 1000); // 20 minutes

      const response = await fetch('/api/process-calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contactIds,
          processTranscriptions: true
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      if (data.success) {
        // Update processed calls
        setCallLogs(prevLogs => 
          prevLogs.map(log => {
            const updatedLog = data.data.find((d: CallLog) => d.contact_id === log.contact_id);
            if (updatedLog) {
              return {
                ...updatedLog,
                transcriptionStatus: updatedLog.existsInSupabase ? "Transcribed" as const : "Failed" as const
              };
            }
            return log;
          })
        );

        setProcessedCount(prev => prev + contactIds.length);
        console.log(`✅ Successfully processed batch: ${contactIds.length} calls`);
        
        // Return remaining calls to continue processing
        return remainingAfterBatch;
      } else {
        throw new Error(data.error || "Batch processing failed");
      }
    } catch (err) {
      console.error(`❌ Error processing batch:`, err);
      
      // Mark failed calls
      setCallLogs(prevLogs => 
        prevLogs.map(log => 
          contactIds.includes(log.contact_id) 
            ? { 
                ...log, 
                transcriptionStatus: "Failed" as const, 
                transcriptionError: err instanceof Error ? err.message : "Unknown error" 
              }
            : log
        )
      );
      
      const errors = contactIds.map(id => ({
        contact_id: id,
        error: err instanceof Error ? err.message : "Unknown error"
      }));
      setProcessingErrors(prev => [...prev, ...errors]);
      
      // Continue with remaining calls even if this batch failed
      return remainingAfterBatch;
    }
  };

  // Auto-process all missing transcriptions in batches of 5
  const autoProcessTranscriptions = useCallback(async (logs: CallLog[]) => {
    if (processingRef.current) return;
    
    const callsNeedingTranscription = logs.filter(log => 
      !log.existsInSupabase && log.recording_location && log.transcriptionStatus !== "Processing"
    );

    if (callsNeedingTranscription.length === 0) {
      console.log("✅ No calls need transcription processing");
      return;
    }

    processingRef.current = true;
    setProcessing(true);
    setProcessingErrors([]);
    setProcessedCount(0);
    setTotalToProcess(callsNeedingTranscription.length);

    console.log(`🎯 Starting auto-processing of ${callsNeedingTranscription.length} calls in batches of ${BATCH_SIZE}`);

    let remainingCalls = [...callsNeedingTranscription];
    let batchNumber = 1;

    while (remainingCalls.length > 0 && processingRef.current) {
      const currentBatchSize = Math.min(remainingCalls.length, BATCH_SIZE);
      console.log(`📦 Processing batch ${batchNumber} (${currentBatchSize} calls): ${remainingCalls.length} remaining`);
      
      remainingCalls = await processBatch(remainingCalls);
      batchNumber++;
      
      // Delay between batches to avoid overwhelming the server
      if (remainingCalls.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay between batches
      }
    }

    const totalProcessed = callsNeedingTranscription.length - remainingCalls.length;
    console.log(`🏁 Auto-processing completed. Total processed: ${totalProcessed}/${callsNeedingTranscription.length}, Failed: ${remainingCalls.length}`);
    
    setProcessing(false);
    processingRef.current = false;
  }, []);

  // Fetch call logs and start auto-processing
  useEffect(() => {
    const fetchCallLogs = async () => {
      if (!selectedDateRange) return;

      setLoading(true);
      setError(null);
      setProcessingErrors([]);
      processingRef.current = false;

      try {
        const params = new URLSearchParams({
          startDate: selectedDateRange.start.toISOString(),
          endDate: selectedDateRange.end.toISOString(),
          processTranscriptions: 'false', // Just fetch data initially
        });

        console.log('📊 Fetching call logs...');

        const response = await fetch(`/api/process-calls?${params}`);
        const data = await response.json();

        if (data.success) {
          const logsWithTranscriptionStatus = data.data.map((log: CallLog) => ({
            ...log,
            transcriptionStatus: log.existsInSupabase ? "Transcribed" : "Pending Transcription",
          }));

          setCallLogs(logsWithTranscriptionStatus);
          console.log('📋 Call logs loaded, starting auto-processing...');
          
          // Start auto-processing after a short delay
          setTimeout(() => {
            autoProcessTranscriptions(logsWithTranscriptionStatus);
          }, 500);

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
  }, [selectedDateRange, checkSupabase, autoProcessTranscriptions]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      processingRef.current = false;
    };
  }, []);

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

          {/* Auto-Processing Status */}
          {processing && (
            <div className="mb-4 p-3 bg-blue-900 border border-blue-600 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-blue-300 font-medium">
                  🚀 Auto-Processing Transcriptions (Batches of {BATCH_SIZE})
                </div>
                <button
                  onClick={() => {
                    processingRef.current = false;
                    setProcessing(false);
                    console.log("🛑 Processing cancelled by user");
                  }}
                  className="px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition-colors"
                >
                  Stop Processing
                </button>
              </div>
              <div className="text-xs text-blue-200">
                Processing {BATCH_SIZE} calls at a time... ({processedCount}/{totalToProcess} completed)
              </div>
              <div className="w-full bg-blue-800 rounded-full h-2 mt-2">
                <div 
                  className="bg-blue-400 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${totalToProcess > 0 ? (processedCount / totalToProcess) * 100 : 0}%` }}
                />
              </div>
              <div className="text-xs text-blue-200 mt-1">
                ⏱️ Each batch takes 5-15 minutes to complete. Please keep this page open.
              </div>
            </div>
          )}

          {/* Processing Errors */}
          {processingErrors.length > 0 && (
            <div className="mb-4 p-3 bg-red-900 border border-red-600 rounded-lg">
              <div className="text-sm text-red-300 font-medium mb-2">
                ⚠️ Processing Errors ({processingErrors.length})
              </div>
              <div className="max-h-32 overflow-y-auto">
                {processingErrors.map((err, index) => (
                  <div key={index} className="text-xs text-red-200 mb-1">
                    <span className="font-mono">{err.contact_id}</span>: {err.error}
                  </div>
                ))}
              </div>
            </div>
          )}

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
                  const transcribedCount = callLogs.filter(log => log.agent_username === agent && log.existsInSupabase).length;
                  return (
                    <option key={agent} value={agent}>
                      {agent} ({agentCallCount} calls, {transcribedCount} transcribed)
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center p-8">
              <div className="text-gray-500">📊 Loading call logs...</div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
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