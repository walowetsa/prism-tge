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
  // Supabase fields for transcribed calls
  transcript_text?: string;
  call_summary?: string;
  sentiment_analysis?: string;
  primary_category?: string;
  categories?: string;
  created_at?: string;
  updated_at?: string;
}

interface ProcessingSummary {
  totalCalls: number;
  existingTranscriptions: number;
  missingTranscriptions: number;
  processedThisRequest: number;
  errors: number;
}

interface ProcessingError {
  contact_id: string;
  error: string;
}

interface AutoProcessingState {
  isRunning: boolean;
  currentBatch: number;
  totalBatches: number;
  processed: number;
  failed: number;
  remaining: number;
}

interface SupabaseCallRecord {
  contact_id: string;
  agent_username: string;
  transcript_text: string;
  call_summary?: string;
  sentiment_analysis?: string;
  primary_category?: string;
  categories?: string;
  queue_name?: string;
  disposition_title?: string;
  recording_location?: string;
  initiation_timestamp: string;
  call_duration?: any;
  created_at: string;
  updated_at: string;
}

type SortField = 'agent_username' | 'initiation_timestamp' | 'total_call_time' | 'queue_name' | 'disposition_title';
type SortDirection = 'asc' | 'desc';

const ITEMS_PER_PAGE = 100;
const BATCH_SIZE = 5;

// CRITICAL FIX: Global flag to prevent multiple auto-processing sessions
const GLOBAL_PROCESSING_KEY = 'autoProcessingActive';

const CallLogDisplay = ({
  selectedDateRange,
  checkSupabase = true,
}: {
  selectedDateRange: DateRange | null;
  checkSupabase?: boolean;
}) => {
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [supabaseRecords, setSupabaseRecords] = useState<SupabaseCallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingSupabase, setLoadingSupabase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processingSummary, setProcessingSummary] = useState<ProcessingSummary | null>(null);
  const [processingErrors, setProcessingErrors] = useState<ProcessingError[]>([]);
  const [autoProcessing, setAutoProcessing] = useState<AutoProcessingState>({
    isRunning: false,
    currentBatch: 0,
    totalBatches: 0,
    processed: 0,
    failed: 0,
    remaining: 0
  });
  const [lastSupabaseUpdate, setLastSupabaseUpdate] = useState<string | null>(null);
  
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>('initiation_timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  // Refs for tracking and cleanup
  const autoProcessingInitiated = useRef<string | null>(null);
  const isAutoProcessingRunning = useRef<boolean>(false);
  const processedContactIds = useRef<Set<string>>(new Set());
  const currentBatchNumber = useRef<number>(0);

  // Fetch all transcribed calls from Supabase
  const fetchSupabaseRecords = async () => {
    setLoadingSupabase(true);
    try {
      console.log('📊 Fetching all transcribed calls from Supabase...');
      
      const response = await fetch('/api/supabase/get-all-transcriptions');
      const data = await response.json();

      if (data.success) {
        setSupabaseRecords(data.data || []);
        setLastSupabaseUpdate(new Date().toISOString());
        console.log(`✅ Loaded ${data.data?.length || 0} transcribed calls from Supabase`);
      } else {
        console.error('Failed to fetch Supabase records:', data.error);
      }
    } catch (err) {
      console.error('Error fetching Supabase records:', err);
    } finally {
      setLoadingSupabase(false);
    }
  };

  // Merge call logs with Supabase records
  const mergedCallLogs = useMemo(() => {
    if (callLogs.length === 0) return [];

    const supabaseMap = new Map(supabaseRecords.map(record => [record.contact_id, record]));
    
    return callLogs.map(log => {
      const supabaseRecord = supabaseMap.get(log.contact_id);
      
      if (supabaseRecord) {
        // Merge with Supabase data
        return {
          ...log,
          existsInSupabase: true,
          transcriptionStatus: "Transcribed" as const,
          transcript_text: supabaseRecord.transcript_text,
          call_summary: supabaseRecord.call_summary,
          sentiment_analysis: supabaseRecord.sentiment_analysis,
          primary_category: supabaseRecord.primary_category,
          categories: supabaseRecord.categories,
          created_at: supabaseRecord.created_at,
          updated_at: supabaseRecord.updated_at,
        };
      } else {
        // Call log without transcription
        return {
          ...log,
          existsInSupabase: false,
          transcriptionStatus: "Pending Transcription" as const,
        };
      }
    });
  }, [callLogs, supabaseRecords]);

  // Get unique agents from merged data
  const uniqueAgents = useMemo(() => {
    const agents = Array.from(new Set(mergedCallLogs.map(log => log.agent_username)))
      .filter(agent => agent && agent.trim() !== "")
      .sort();
    return agents;
  }, [mergedCallLogs]);

  // Filter and sort merged call logs
  const filteredAndSortedCallLogs = useMemo(() => {
    let filtered = mergedCallLogs;
    
    if (selectedAgent !== "all") {
      filtered = mergedCallLogs.filter(log => log.agent_username === selectedAgent);
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
  }, [mergedCallLogs, selectedAgent, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedCallLogs.length / ITEMS_PER_PAGE);
  const paginatedCallLogs = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return filteredAndSortedCallLogs.slice(startIndex, endIndex);
  }, [filteredAndSortedCallLogs, currentPage]);

  // Calculate processing summary from merged data
  const calculatedSummary = useMemo(() => {
    const total = mergedCallLogs.length;
    const transcribed = mergedCallLogs.filter(log => log.existsInSupabase).length;
    const missing = mergedCallLogs.filter(log => !log.existsInSupabase && log.recording_location).length;
    
    return {
      totalCalls: total,
      existingTranscriptions: transcribed,
      missingTranscriptions: missing,
      processedThisRequest: autoProcessing.processed,
      errors: autoProcessing.failed
    };
  }, [mergedCallLogs, autoProcessing.processed, autoProcessing.failed]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Audio download function
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

  // Get transcription status with enhanced info
  const getTranscriptionStatus = (log: CallLog) => {
    if (log.existsInSupabase) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
              title={`Transcribed: ${log.transcript_text ? log.transcript_text.substring(0, 100) + '...' : 'No preview'}`}>
          <div className="w-2 h-2 bg-green-500 rounded-full mr-1"></div>
          Transcribed
          {log.primary_category && (
            <span className="ml-1 text-green-600">({log.primary_category})</span>
          )}
        </span>
      );
    } else if (log.transcriptionStatus === "Processing" || autoProcessing.isRunning) {
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

  // Process batch function
  const processBatch = async (batchNumber: number) => {
    if (!selectedDateRange) return false;

    try {
      const excludeContactIds = Array.from(processedContactIds.current);
      
      const params = new URLSearchParams({
        startDate: selectedDateRange.start.toISOString(),
        endDate: selectedDateRange.end.toISOString(),
        processTranscriptions: 'true',
        maxProcessCount: BATCH_SIZE.toString(),
        excludeContactIds: excludeContactIds.join(','),
      });

      console.log(`🚀 Processing batch ${batchNumber} (max ${BATCH_SIZE} calls, excluding ${excludeContactIds.length} already processed)...`);
      console.log(`📋 First 10 excluded contact IDs:`, excludeContactIds.slice(0, 10));

      const response = await fetch(`/api/process-calls?${params}`);
      const data = await response.json();

      if (data.success) {
        // Track newly processed contact IDs
        if (data.processedContactIds && Array.isArray(data.processedContactIds)) {
          data.processedContactIds.forEach((id: string) => {
            processedContactIds.current.add(id);
          });
          console.log(`📝 Added ${data.processedContactIds.length} new contact IDs to exclusion list`);
          console.log(`📊 Total exclusion list size: ${processedContactIds.current.size}`);
        }

        // Refresh Supabase data
        await fetchSupabaseRecords();

        // Handle processing errors
        if (data.errors && data.errors.length > 0) {
          setProcessingErrors(prev => [...prev, ...data.errors]);
        }

        // Update auto-processing state
        const processed = data.summary.processedThisRequest || 0;
        const errors = data.errors?.length || 0;
        const remaining = data.summary.missingTranscriptions || 0;

        setAutoProcessing(prev => ({
          ...prev,
          processed: prev.processed + processed,
          failed: prev.failed + errors,
          remaining: remaining
        }));

        console.log(`✅ Batch ${batchNumber} completed:`);
        console.log(`   - Processed: ${processed} calls`);
        console.log(`   - Errors: ${errors} calls`);
        console.log(`   - Remaining: ${remaining} calls`);
        
        const hasMoreWork = remaining > 0;
        console.log(`🤔 Has more work after batch ${batchNumber}? ${hasMoreWork}`);
        
        return hasMoreWork;
      } else {
        console.error(`❌ Batch ${batchNumber} failed:`, data.error);
        setAutoProcessing(prev => ({
          ...prev,
          failed: prev.failed + 1
        }));
        return false;
      }
    } catch (err) {
      console.error(`❌ Network error in batch ${batchNumber}:`, err);
      setAutoProcessing(prev => ({
        ...prev,
        failed: prev.failed + 1
      }));
      return false;
    }
  };

  // Auto-process all transcriptions
  const autoProcessAllTranscriptions = async (missingCount: number) => {
    if (missingCount === 0) {
      console.log('🚫 No missing transcriptions to process');
      return;
    }

    // Check global processing state
    const globalProcessingActive = sessionStorage.getItem(GLOBAL_PROCESSING_KEY);
    if (globalProcessingActive) {
      console.log('🚫 Auto-processing already running in another session/tab, skipping...');
      return;
    }

    if (isAutoProcessingRunning.current) {
      console.log('🚫 Auto-processing already running in this session, skipping...');
      return;
    }

    console.log(`🎯 Starting auto-processing: ${missingCount} calls missing`);
    
    sessionStorage.setItem(GLOBAL_PROCESSING_KEY, Date.now().toString());
    isAutoProcessingRunning.current = true;

    processedContactIds.current.clear();
    currentBatchNumber.current = 0;

    const totalBatches = Math.ceil(missingCount / BATCH_SIZE);
    
    console.log(`📋 Planning: ${totalBatches} batches of ${BATCH_SIZE} calls each`);

    setAutoProcessing({
      isRunning: true,
      currentBatch: 0,
      totalBatches,
      processed: 0,
      failed: 0,
      remaining: missingCount
    });

    setProcessing(true);
    setProcessingErrors([]);

    let currentBatch = 1;
    let hasMoreToProcess = true;
    let consecutiveEmptyBatches = 0;
    const MAX_EMPTY_BATCHES = 3;

    try {
      while (hasMoreToProcess && currentBatch <= totalBatches && consecutiveEmptyBatches < MAX_EMPTY_BATCHES) {
        currentBatchNumber.current = currentBatch;
        
        setAutoProcessing(prev => ({
          ...prev,
          currentBatch
        }));

        const excludedCount = processedContactIds.current.size;
        console.log(`\n🚀 === BATCH ${currentBatch}/${totalBatches} STARTING ===`);
        console.log(`📊 Processed so far: ${excludedCount} calls`);

        const batchStartProcessedCount = autoProcessing.processed;
        hasMoreToProcess = await processBatch(currentBatch);
        const batchEndProcessedCount = autoProcessing.processed;
        
        const batchProcessedCount = batchEndProcessedCount - batchStartProcessedCount;
        console.log(`📊 Batch ${currentBatch} results: ${batchProcessedCount} processed`);
        
        if (batchProcessedCount === 0) {
          consecutiveEmptyBatches++;
          console.log(`⚠️ Empty batch ${currentBatch} (${consecutiveEmptyBatches}/${MAX_EMPTY_BATCHES} consecutive)`);
        } else {
          consecutiveEmptyBatches = 0;
          console.log(`✅ Successful batch ${currentBatch}: ${batchProcessedCount} calls processed`);
        }
        
        if (!hasMoreToProcess) {
          console.log(`✅ No more transcriptions needed after batch ${currentBatch}`);
          break;
        }

        if (consecutiveEmptyBatches >= MAX_EMPTY_BATCHES) {
          console.log(`🛑 Stopping: ${MAX_EMPTY_BATCHES} consecutive empty batches indicate no more work`);
          break;
        }

        if (currentBatch < totalBatches) {
          console.log(`⏸️ Waiting 8 seconds before batch ${currentBatch + 1}...`);
          await new Promise(resolve => setTimeout(resolve, 8000));
        }

        currentBatch++;
        console.log(`🏁 === BATCH ${currentBatch - 1}/${totalBatches} COMPLETED ===\n`);
      }
    } catch (error) {
      console.error('❌ Error in auto-processing:', error);
    } finally {
      const totalProcessed = processedContactIds.current.size;
      
      setAutoProcessing(prev => ({
        ...prev,
        isRunning: false
      }));

      setProcessing(false);
      
      sessionStorage.removeItem(GLOBAL_PROCESSING_KEY);
      isAutoProcessingRunning.current = false;

      console.log(`\n🎉 === AUTO-PROCESSING COMPLETED ===`);
      console.log(`📊 Total unique calls processed: ${totalProcessed}`);
      
      processedContactIds.current.clear();
      currentBatchNumber.current = 0;
      
      console.log(`🧹 Cleared tracking state and global processing flag`);
    }
  };

  // Component cleanup
  useEffect(() => {
    return () => {
      if (isAutoProcessingRunning.current) {
        console.log('🧹 Component unmounting - clearing global processing flag');
        sessionStorage.removeItem(GLOBAL_PROCESSING_KEY);
      }
    };
  }, []);

  // Reset filters when data changes
  useEffect(() => {
    setSelectedAgent("all");
    setCurrentPage(1);
  }, [selectedDateRange]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedAgent, sortField, sortDirection]);

  // Fetch call logs
  useEffect(() => {
    const fetchCallLogs = async () => {
      if (!selectedDateRange) return;

      const dateRangeKey = `${selectedDateRange.start.toISOString()}-${selectedDateRange.end.toISOString()}`;

      if (isAutoProcessingRunning.current) {
        console.log('🚫 Skipping fetchCallLogs - auto-processing is currently running');
        return;
      }

      setLoading(true);
      setError(null);
      setProcessingSummary(null);
      setProcessingErrors([]);
      setAutoProcessing({
        isRunning: false,
        currentBatch: 0,
        totalBatches: 0,
        processed: 0,
        failed: 0,
        remaining: 0
      });

      try {
        console.log('🔍 Step 1: Fetching Supabase transcriptions...');
        await fetchSupabaseRecords();

        console.log('📊 Step 2: Fetching call logs from database...');
        const params = new URLSearchParams({
          startDate: selectedDateRange.start.toISOString(),
          endDate: selectedDateRange.end.toISOString(),
          processTranscriptions: 'false',
        });

        const response = await fetch(`/api/process-calls?${params}`);
        const data = await response.json();

        if (data.success) {
          setCallLogs(data.data || []);
          console.log('📋 Call logs loaded:', data.summary);
          console.log('🚫 Real-time updates DISABLED - no more repeated checking every 10 seconds');

          const missing = data.summary.missingTranscriptions;
          const shouldStartAutoProcessing = (
            missing > 0 && 
            autoProcessingInitiated.current !== dateRangeKey && 
            !isAutoProcessingRunning.current
          );
          
          console.log(`🤔 Should start auto-processing? ${shouldStartAutoProcessing}`);
          console.log(`   - Missing: ${missing}`);
          console.log(`   - Not initiated for this date range: ${autoProcessingInitiated.current !== dateRangeKey}`);
          console.log(`   - Not currently running: ${!isAutoProcessingRunning.current}`);
          
          if (shouldStartAutoProcessing) {
            autoProcessingInitiated.current = dateRangeKey;
            console.log(`🚀 Auto-starting transcription processing for ${missing} missing calls...`);
            
            setTimeout(() => {
              if (!isAutoProcessingRunning.current) {
                autoProcessAllTranscriptions(missing);
              } else {
                console.log('🚫 Auto-processing started elsewhere, canceling delayed start');
              }
            }, 1000);
          } else {
            console.log('⏭️ Skipping auto-processing start');
          }

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
        <h5 className="text-[#4ecca3]">Call Logs & Transcriptions</h5>
        <div className="flex items-center gap-2">
          {lastSupabaseUpdate && (
            <div className="text-xs text-gray-400">
              Last updated: {new Date(lastSupabaseUpdate).toLocaleTimeString()}
            </div>
          )}
          <Link
            href="/tge/overview"
            className="px-3 py-2 bg-[#4ecca3] text-[#0a101b] rounded-lg hover:bg-[#3bb891] transition-colors text-sm font-medium"
          >
            View All Transcribed Calls
          </Link>
        </div>
      </div>

      {!selectedDateRange ? (
        <div>Please Select A Date Range</div>
      ) : (
        <div>
          <div className="mb-4">
            <h6 className="text-sm text-white">
              Call Data for {selectedDateRange.label}
              {loadingSupabase && (
                <span className="ml-2 text-xs text-yellow-400">🔄 Refreshing transcriptions...</span>
              )}
            </h6>
          </div>

          {/* Status Banner */}
          <div className="mb-4 p-2 bg-blue-900 border border-blue-600 rounded-lg">
            <div className="text-xs text-blue-300">
              📊 Auto-processing will check for missing transcriptions and process them automatically
              {isAutoProcessingRunning.current && (
                <span className="ml-2 text-yellow-400">(Currently auto-processing)</span>
              )}
            </div>
          </div>

          {/* Auto-Processing Status */}
          {autoProcessing.isRunning && (
            <div className="mb-4 p-4 bg-blue-900 border border-blue-600 rounded-lg">
              <div className="text-sm text-blue-300 font-medium mb-2">
                🤖 Auto-Processing Transcriptions (Batch Progression)
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs text-blue-200">
                <div>Batch: <span className="text-white font-medium">{autoProcessing.currentBatch}/{autoProcessing.totalBatches}</span></div>
                <div>Processed: <span className="text-green-400 font-medium">{autoProcessing.processed}</span></div>
                <div>Failed: <span className="text-red-400 font-medium">{autoProcessing.failed}</span></div>
                <div>Remaining: <span className="text-yellow-400 font-medium">{autoProcessing.remaining}</span></div>
                <div>Excluded: <span className="text-gray-400 font-medium">{processedContactIds.current.size}</span></div>
              </div>
              <div className="mt-2">
                <div className="w-full bg-blue-800 rounded-full h-2">
                  <div 
                    className="bg-blue-400 h-2 rounded-full transition-all duration-500" 
                    style={{ 
                      width: `${autoProcessing.totalBatches > 0 ? (autoProcessing.currentBatch / autoProcessing.totalBatches) * 100 : 0}%` 
                    }}
                  ></div>
                </div>
                <div className="text-xs text-blue-300 mt-1">
                  Processing {BATCH_SIZE} calls per batch with 8-second delays (no repeated checking - processes different calls each batch)
                </div>
              </div>
            </div>
          )}

          {/* Enhanced Processing Summary */}
          <div className="mb-4 p-3 bg-bg-primary border border-border rounded-lg">
            <div className="text-sm text-[#4ecca3] font-medium mb-2">
              📊 Live Processing Summary
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs text-gray-300">
              <div>Total Calls: <span className="text-white font-medium">{calculatedSummary.totalCalls}</span></div>
              <div>Transcribed: <span className="text-green-400 font-medium">{calculatedSummary.existingTranscriptions}</span></div>
              <div>Missing: <span className="text-yellow-400 font-medium">{calculatedSummary.missingTranscriptions}</span></div>
              <div>Auto-Processed: <span className="text-blue-400 font-medium">{autoProcessing.processed}</span></div>
              <div>Errors: <span className="text-red-400 font-medium">{autoProcessing.failed}</span></div>
            </div>
            
            {calculatedSummary.missingTranscriptions > 0 && !autoProcessing.isRunning && (
              <div className="mt-3 flex items-center gap-2">
                <div className="text-xs text-green-400 font-medium">
                  🤖 Auto-processing will start automatically for missing transcriptions (no more repeated checking!)
                </div>
                <button
                  onClick={() => fetchSupabaseRecords()}
                  className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700"
                >
                  🔄 Manual Refresh
                </button>
              </div>
            )}
          </div>

          {/* Processing Errors */}
          {processingErrors.length > 0 && (
            <div className="mb-4 p-3 bg-red-900 border border-red-600 rounded-lg">
              <div className="text-sm text-red-300 font-medium mb-2">
                ⚠️ Processing Errors ({processingErrors.length})
              </div>
              <div className="max-h-32 overflow-y-auto">
                {processingErrors.slice(0, 10).map((err, index) => (
                  <div key={index} className="text-xs text-red-200 mb-1">
                    <span className="font-mono">{err.contact_id}</span>: {err.error}
                  </div>
                ))}
                {processingErrors.length > 10 && (
                  <div className="text-xs text-red-300 mt-2">
                    ... and {processingErrors.length - 10} more errors
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Enhanced Agent Filter */}
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
                <option value="all">All Agents ({mergedCallLogs.length} calls)</option>
                {uniqueAgents.map((agent) => {
                  const agentCallCount = mergedCallLogs.filter(log => log.agent_username === agent).length;
                  const transcribedCount = mergedCallLogs.filter(log => log.agent_username === agent && log.existsInSupabase).length;
                  return (
                    <option key={agent} value={agent}>
                      {agent} ({agentCallCount} calls, {transcribedCount} transcribed)
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {(loading || loadingSupabase) && (
            <div className="flex items-center justify-center p-8">
              <div className="text-gray-500">
                {loading && loadingSupabase ? "📊 Loading call logs and transcriptions..." : 
                 loading ? "📊 Loading call logs..." : 
                 "🔍 Fetching transcriptions from Supabase..."}
              </div>
            </div>
          )}

          {(processing || autoProcessing.isRunning) && (
            <div className="flex items-center justify-center p-4 mb-4 bg-yellow-900 border border-yellow-600 rounded-lg">
              <div className="text-yellow-200">
                {autoProcessing.isRunning 
                  ? `🤖 Auto-processing batch ${autoProcessing.currentBatch}/${autoProcessing.totalBatches} (no repeated checking - processing different calls each batch, ${processedContactIds.current.size} excluded)...` 
                  : '🚀 Processing transcriptions...'
                }
              </div>
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
                    : `Showing ${filteredAndSortedCallLogs.length} call(s) for ${selectedAgent} - Page ${currentPage} of ${totalPages} (${paginatedCallLogs.length} records) - ${mergedCallLogs.length} total calls`
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
                            className={`hover:bg-gray-800 transition-colors ${log.existsInSupabase ? 'bg-green-900/20' : ''}`}
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
                                  {log.existsInSupabase ? 'View Transcript' : 'View Details'}
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