/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
// import SystemStatus from "./SystemStatus"; // Uncomment to use system status

interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

interface TranscribedCall {
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

interface SummaryStats {
  totalInDateRange: number;
  totalFiltered: number;
  categoryStats: Array<{
    category: string;
    count: number;
  }>;
  agentStats: Array<{
    agent: string;
    count: number;
  }>;
}

type SortField = 'agent_username' | 'initiation_timestamp' | 'call_duration' | 'queue_name' | 'disposition_title' | 'primary_category' | 'created_at';
type SortDirection = 'asc' | 'desc';

const ITEMS_PER_PAGE = 50;
const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

const CallLogDisplay = ({
  selectedDateRange,
}: {
  selectedDateRange: DateRange | null;
}) => {
  const [transcribedCalls, setTranscribedCalls] = useState<TranscribedCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [backgroundProcessingTriggered, setBackgroundProcessingTriggered] = useState(false);
  
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [downloadingAudio, setDownloadingAudio] = useState<string[]>([]);

  // Ref for auto-refresh interval
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);

  // Fetch transcribed calls from Supabase
  const fetchTranscribedCalls = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);

    try {
      console.log('📊 Fetching transcribed calls from Supabase...');
      
      const response = await fetch('/api/supabase/get-all-transcriptions');
      const data = await response.json();

      if (data.success) {
        setTranscribedCalls(data.data || []);
        setLastUpdate(new Date().toISOString());
        console.log(`✅ Loaded ${data.data?.length || 0} transcribed calls`);
      } else {
        setError(data.error || 'Failed to fetch transcribed calls');
        console.error('Failed to fetch transcribed calls:', data.error);
      }
    } catch (err) {
      setError('Network error occurred while fetching transcribed calls');
      console.error('Error fetching transcribed calls:', err);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  // Filter calls by date range
  const dateFilteredCalls = useMemo(() => {
    if (!selectedDateRange) return transcribedCalls;

    return transcribedCalls.filter(call => {
      const callDate = new Date(call.initiation_timestamp);
      return callDate >= selectedDateRange.start && callDate <= selectedDateRange.end;
    });
  }, [transcribedCalls, selectedDateRange]);

  // Get unique agents from filtered data
  const uniqueAgents = useMemo(() => {
    const agents = Array.from(new Set(dateFilteredCalls.map(call => call.agent_username)))
      .filter(agent => agent && agent.trim() !== "")
      .sort();
    return agents;
  }, [dateFilteredCalls]);

  // Get unique categories from filtered data
  const uniqueCategories = useMemo(() => {
    const categories = Array.from(new Set(
      dateFilteredCalls
        .map(call => call.primary_category)
        .filter(category => category && category.trim() !== "")
    )).sort();
    return categories;
  }, [dateFilteredCalls]);

  // Filter, search, and sort calls
  const filteredAndSortedCalls = useMemo(() => {
    let filtered = dateFilteredCalls;
    
    // Agent filter
    if (selectedAgent !== "all") {
      filtered = filtered.filter(call => call.agent_username === selectedAgent);
    }
    
    // Category filter
    if (selectedCategory !== "all") {
      filtered = filtered.filter(call => call.primary_category === selectedCategory);
    }
    
    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(call => 
        call.agent_username?.toLowerCase().includes(query) ||
        call.primary_category?.toLowerCase().includes(query) ||
        call.queue_name?.toLowerCase().includes(query) ||
        call.disposition_title?.toLowerCase().includes(query) ||
        call.transcript_text?.toLowerCase().includes(query) ||
        call.call_summary?.toLowerCase().includes(query) ||
        call.contact_id.toLowerCase().includes(query)
      );
    }
    
    // Sort
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
        case 'call_duration':
          // Parse call_duration JSON if it exists
          const aDuration = a.call_duration ? JSON.parse(a.call_duration) : { minutes: 0, seconds: 0 };
          const bDuration = b.call_duration ? JSON.parse(b.call_duration) : { minutes: 0, seconds: 0 };
          aValue = (aDuration.minutes || 0) * 60 + (aDuration.seconds || 0);
          bValue = (bDuration.minutes || 0) * 60 + (bDuration.seconds || 0);
          break;
        case 'queue_name':
          aValue = a.queue_name || '';
          bValue = b.queue_name || '';
          break;
        case 'disposition_title':
          aValue = a.disposition_title || '';
          bValue = b.disposition_title || '';
          break;
        case 'primary_category':
          aValue = a.primary_category || '';
          bValue = b.primary_category || '';
          break;
        case 'created_at':
          aValue = new Date(a.created_at).getTime();
          bValue = new Date(b.created_at).getTime();
          break;
        default:
          return 0;
      }
      
      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [dateFilteredCalls, selectedAgent, selectedCategory, searchQuery, sortField, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedCalls.length / ITEMS_PER_PAGE);
  const paginatedCalls = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return filteredAndSortedCalls.slice(startIndex, endIndex);
  }, [filteredAndSortedCalls, currentPage]);

  // Summary statistics
  const summaryStats = useMemo(() => {
    const totalInDateRange = dateFilteredCalls.length;
    const totalFiltered = filteredAndSortedCalls.length;
    
    // Category breakdown
    const categoryStats = uniqueCategories.map(category => ({
      category,
      count: dateFilteredCalls.filter(call => call.primary_category === category).length
    }));

    // Agent breakdown  
    const agentStats = uniqueAgents.map(agent => ({
      agent,
      count: dateFilteredCalls.filter(call => call.agent_username === agent).length
    }));

    return {
      totalInDateRange,
      totalFiltered,
      categoryStats,
      agentStats
    };
  }, [dateFilteredCalls, filteredAndSortedCalls, uniqueCategories, uniqueAgents]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Audio download function
  const handleAudioDownload = async (call: TranscribedCall) => {
    if (!call.recording_location) {
      alert("No audio file available for this call");
      return;
    }

    const contactId = call.contact_id;
    
    if (downloadingAudio.includes(contactId)) return;

    setDownloadingAudio(prev => [...prev, contactId]);

    try {
      console.log(`🎵 Downloading call recording: ${contactId}`);

      const downloadUrl = `/api/sftp/download?filename=${encodeURIComponent(call.recording_location)}`;
      
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
      a.download = call.recording_location.split('/').pop() || `call_${contactId}.wav`;
      
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

  // Reset filters when date range changes
  useEffect(() => {
    setSelectedAgent("all");
    setSelectedCategory("all");
    setSearchQuery("");
    setCurrentPage(1);
    setBackgroundProcessingTriggered(false);
  }, [selectedDateRange]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedAgent, selectedCategory, searchQuery, sortField, sortDirection]);

  // Auto-trigger background processing for missing transcriptions
  const triggerBackgroundProcessing = async (dateRange: DateRange) => {
    try {
      console.log('🎯 Auto-triggering background processing for date range...');
      setBackgroundProcessingTriggered(true);
      
      const response = await fetch('/api/auto-process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: dateRange.start.toISOString(),
          endDate: dateRange.end.toISOString(),
        }),
      });

      const data = await response.json();
      
      if (data.success) {
        console.log('✅ Background processing auto-triggered');
      } else {
        console.log('⚠️ Auto-trigger response:', data);
      }
    } catch (error) {
      console.error('❌ Failed to auto-trigger background processing:', error);
      // Don't show error to user since this is background functionality
    }
  };

  // Setup auto-refresh and auto-trigger
  useEffect(() => {
    // Initial fetch
    fetchTranscribedCalls();

    // Auto-trigger background processing if date range is selected
    if (selectedDateRange) {
      triggerBackgroundProcessing(selectedDateRange);
    }

    // Setup auto-refresh interval
    refreshInterval.current = setInterval(() => {
      console.log('🔄 Auto-refreshing transcribed calls...');
      fetchTranscribedCalls(false); // Don't show loading spinner for auto-refresh
    }, AUTO_REFRESH_INTERVAL);

    // Cleanup on unmount
    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
        refreshInterval.current = null;
      }
    };
  }, [selectedDateRange]); // Add selectedDateRange as dependency

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatCallDuration = (callDurationJson?: any) => {
    if (!callDurationJson) return "N/A";
    
    try {
      const duration = typeof callDurationJson === 'string' 
        ? JSON.parse(callDurationJson) 
        : callDurationJson;
      const { minutes = 0, seconds = 0 } = duration;
      return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    } catch {
      return "N/A";
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '↕️';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  const getCategoryBadgeColor = (category?: string) => {
    if (!category) return "bg-gray-100 text-gray-800";
    
    const colors = {
      "Customer Service": "bg-blue-100 text-blue-800",
      "Sales": "bg-green-100 text-green-800",
      "Support": "bg-yellow-100 text-yellow-800",
      "Complaint": "bg-red-100 text-red-800",
      "Inquiry": "bg-purple-100 text-purple-800",
      "Follow-up": "bg-indigo-100 text-indigo-800",
      "Uncategorised": "bg-gray-100 text-gray-800"
    };
    
    return colors[category as keyof typeof colors] || "bg-teal-100 text-teal-800";
  };

  return (
    <div className="flex-1 border-2 p-4 rounded border-border bg-bg-secondary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h5 className="text-[#4ecca3] text-xl font-semibold">Transcribed Call Logs</h5>
          <p className="text-gray-400 text-sm mt-1">
            Automatically processed and transcribed calls
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdate && (
            <div className="text-xs text-gray-400">
              Last updated: {new Date(lastUpdate).toLocaleTimeString()}
            </div>
          )}
          
          {/* Uncomment to add system status indicator
          <SystemStatus />
          */}
          
          <button
            onClick={() => fetchTranscribedCalls()}
            disabled={loading}
            className={`px-3 py-2 rounded-lg transition-colors text-sm font-medium disabled:opacity-50 ${
              backgroundProcessingTriggered 
                ? 'bg-blue-600 text-white hover:bg-blue-700' 
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {loading ? '🔄 Refreshing...' : '🔄 Refresh'}
            {backgroundProcessingTriggered && !loading && (
              <span className="ml-1 w-2 h-2 bg-blue-300 rounded-full inline-block animate-pulse"></span>
            )}
          </button>
          <Link
            href="/tge/overview"
            className="px-3 py-2 bg-[#4ecca3] text-[#0a101b] rounded-lg hover:bg-[#3bb891] transition-colors text-sm font-medium"
          >
            📊 Analytics Overview
          </Link>
        </div>
      </div>

      {!selectedDateRange ? (
        <div className="text-center py-12">
          <div className="text-gray-500 text-lg">Please Select A Date Range</div>
          <div className="text-gray-400 text-sm mt-2">
            Choose a date range to view transcribed calls from that period
          </div>
        </div>
      ) : (
        <div>
          {/* Background Processing Notification */}
          {backgroundProcessingTriggered && (
            <div className="mb-6 p-4 bg-blue-900 border border-blue-600 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <div className="w-3 h-3 bg-blue-400 rounded-full mr-3 animate-pulse"></div>
                  <div>
                    <div className="text-sm text-blue-300 font-medium">
                      🤖 Background Processing Active
                    </div>
                    <div className="text-xs text-blue-200 mt-1">
                      Automatically transcribing calls for {selectedDateRange.label}. New transcriptions will appear here as they complete.
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setBackgroundProcessingTriggered(false)}
                  className="text-blue-300 hover:text-blue-100 text-lg"
                  title="Dismiss notification"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Summary Statistics */}
          {summaryStats.totalInDateRange > 0 && (
            <div className="mb-6 p-4 bg-bg-primary border border-border rounded-lg">
              <div className="text-sm text-[#4ecca3] font-medium mb-3">
                📊 Summary for {selectedDateRange.label}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="text-center">
                  <div className="text-2xl font-bold text-white">{summaryStats.totalInDateRange}</div>
                  <div className="text-gray-400">Total Transcribed</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-white">{uniqueAgents.length}</div>
                  <div className="text-gray-400">Agents</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-white">{uniqueCategories.length}</div>
                  <div className="text-gray-400">Categories</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-white">{summaryStats.totalFiltered}</div>
                  <div className="text-gray-400">Filtered Results</div>
                </div>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="mb-6 grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Search */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                🔍 Search:
              </label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search calls, agents, categories..."
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#4ecca3] focus:border-transparent"
              />
            </div>

            {/* Agent Filter */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                👤 Agent:
              </label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#4ecca3] focus:border-transparent"
              >
                <option value="all">All Agents ({summaryStats.totalInDateRange})</option>
                {uniqueAgents.map((agent) => {
                  const count = summaryStats.agentStats.find(s => s.agent === agent)?.count || 0;
                  return (
                    <option key={agent} value={agent}>
                      {agent} ({count})
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Category Filter */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                🏷️ Category:
              </label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#4ecca3] focus:border-transparent"
              >
                <option value="all">All Categories ({summaryStats.totalInDateRange})</option>
                {uniqueCategories.map((category) => {
                  const count = summaryStats.categoryStats.find(s => s.category === category)?.count || 0;
                  return (
                    <option key={category} value={category}>
                      {category} ({count})
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Clear Filters */}
            <div className="flex items-end">
              <button
                onClick={() => {
                  setSelectedAgent("all");
                  setSelectedCategory("all");
                  setSearchQuery("");
                  setCurrentPage(1);
                }}
                className="w-full px-3 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors text-sm font-medium"
              >
                🧹 Clear Filters
              </button>
            </div>
          </div>

          {loading && (
            <div className="flex items-center justify-center p-12">
              <div className="text-gray-500 text-lg">
                📊 Loading transcribed calls...
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6 flex items-center justify-between">
              <span>Error: {error}</span>
              <button 
                onClick={() => setError(null)}
                className="ml-2 text-red-500 hover:text-red-700 font-bold"
              >
                ✕
              </button>
            </div>
          )}

          {!loading && !error && (
            <div>
              <div className="mb-4 flex justify-between items-center">
                <div className="text-sm text-white">
                  Showing {paginatedCalls.length} of {filteredAndSortedCalls.length} transcribed calls
                  {filteredAndSortedCalls.length !== summaryStats.totalInDateRange && 
                    ` (${summaryStats.totalInDateRange} total in date range)`
                  }
                  {totalPages > 1 && ` - Page ${currentPage} of ${totalPages}`}
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

              {filteredAndSortedCalls.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-gray-500 text-lg">
                    {summaryStats.totalInDateRange === 0 
                      ? "No transcribed calls found for this date range" 
                      : "No calls match your current filters"
                    }
                  </div>
                  <div className="text-gray-400 text-sm mt-2">
                    {summaryStats.totalInDateRange === 0
                      ? (backgroundProcessingTriggered 
                          ? "Background transcription is processing calls automatically. Check back in a few minutes." 
                          : "Calls may still be processing. Transcription happens automatically in the background.")
                      : "Try adjusting your search terms or filters"
                    }
                  </div>
                  {summaryStats.totalInDateRange === 0 && (
                    <button
                      onClick={() => fetchTranscribedCalls()}
                      className="mt-4 px-4 py-2 bg-[#4ecca3] text-[#0a101b] rounded-lg hover:bg-[#3bb891] transition-colors text-sm font-medium"
                    >
                      🔄 Check for New Transcriptions
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-hidden border border-border rounded-lg">
                  <div className="overflow-x-auto max-h-[calc(100vh-500px)]">
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
                            onClick={() => handleSort('call_duration')}
                          >
                            Duration {getSortIcon('call_duration')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('queue_name')}
                          >
                            Queue {getSortIcon('queue_name')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('primary_category')}
                          >
                            Category {getSortIcon('primary_category')}
                          </th>
                          <th 
                            className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider cursor-pointer hover:bg-gray-700 transition-colors"
                            onClick={() => handleSort('created_at')}
                          >
                            Transcribed {getSortIcon('created_at')}
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-white uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {paginatedCalls.map((call) => (
                          <tr 
                            key={call.contact_id}
                            className="hover:bg-gray-800 transition-colors bg-green-900/10"
                          >
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {call.agent_username}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {formatTimestamp(call.initiation_timestamp)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {formatCallDuration(call.call_duration)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-[#4ecca3]">
                              {call.queue_name || "N/A"}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getCategoryBadgeColor(call.primary_category)}`}>
                                {call.primary_category || "Uncategorised"}
                              </span>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-400">
                              {formatTimestamp(call.created_at)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              <div className="flex items-center space-x-2">
                                <Link 
                                  href={`/tge/${call.contact_id}`}
                                  className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-[#4ecca3] hover:bg-[#3bb891] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4ecca3] transition-colors"
                                >
                                  📄 View Transcript
                                </Link>
                                
                                {call.recording_location && (
                                  <button
                                    onClick={() => handleAudioDownload(call)}
                                    disabled={downloadingAudio.includes(call.contact_id)}
                                    className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                                    title="Download audio file"
                                  >
                                    {downloadingAudio.includes(call.contact_id) ? (
                                      <>
                                        <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Downloading...
                                      </>
                                    ) : (
                                      <>
                                        🎵 Audio
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