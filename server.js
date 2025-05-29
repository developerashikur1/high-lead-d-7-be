import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// D7 API Configuration
const D7_API_KEY = process.env.D7_API_KEY || '3d1e79ffe6bfde4dd8de9ac158979865_MTc5NTI2';
const D7_BASE_URL = 'https://dash.d7leadfinder.com/app/api';

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Error handling utility
const handleApiError = (error, operation) => {
  console.error(`[${new Date().toISOString()}] Error in ${operation}:`, {
    message: error.message,
    stack: error.stack,
    name: error.name
  });
  
  if (error.name === 'FetchError') {
    return { statusCode: 502, message: 'External API connection failed' };
  }
  if (error.message.includes('timeout')) {
    return { statusCode: 504, message: 'Request timeout' };
  }
  return { statusCode: 500, message: 'Internal server error' };
};

// Validation middleware
const validateSearchParams = (req, res, next) => {
  const { niche, city, country } = req.body;
  
  if (!niche || !city || !country) {
    return res.status(400).json({
      error: 'Missing required parameters',
      required: ['niche', 'city', 'country'],
      received: { niche: !!niche, city: !!city, country: !!country }
    });
  }
  
  if (typeof niche !== 'string' || typeof city !== 'string' || typeof country !== 'string') {
    return res.status(400).json({
      error: 'Invalid parameter types',
      message: 'All parameters must be strings'
    });
  }
  
  if (niche.length > 100 || city.length > 100 || country.length > 100) {
    return res.status(400).json({
      error: 'Parameter too long',
      message: 'Parameters must be less than 100 characters'
    });
  }
  
  next();
};

const validateResultsParams = (req, res, next) => {
  const { searchid } = req.body;
  
  if (!searchid) {
    return res.status(400).json({
      error: 'Missing required parameter: searchid'
    });
  }
  
  if (!Number.isInteger(Number(searchid)) || Number(searchid) <= 0) {
    return res.status(400).json({
      error: 'Invalid searchid',
      message: 'searchid must be a positive integer'
    });
  }
  
  next();
};

// Transform D7 data to standardized format
const transformD7Results = (rawResults, originalParams) => {
  if (!Array.isArray(rawResults)) {
    console.warn('D7 API returned non-array results:', typeof rawResults);
    return [];
  }
  
  return rawResults.map((item, index) => {
    try {
      return {
        id: `d7_${Date.now()}_${index}`,
        name: item.name || item.title || 'Unknown',
        email: item.email || item.mail || '',
        phone: item.phone || item.telephone || item.mobile || '',
        website: item.website || item.url || item.site || '',
        company: item.company || item.business || item.name || 'Unknown Company',
        city: item.city || item.address2 || item.location || originalParams.city,
        address: item.address || item.full_address || '',
        country: originalParams.country,
        source: 'D7 Lead Finder',
        timestamp: new Date().toISOString()
      };
    } catch (transformError) {
      console.error('Error transforming individual result:', transformError, item);
      return {
        id: `d7_error_${Date.now()}_${index}`,
        name: 'Data Error',
        email: '',
        phone: '',
        website: '',
        company: 'Error Processing Data',
        city: originalParams.city,
        address: '',
        country: originalParams.country,
        source: 'D7 Lead Finder',
        timestamp: new Date().toISOString()
      };
    }
  });
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// API info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    service: 'D7 Lead Finder Proxy Server',
    version: '1.0.0',
    endpoints: {
      search: 'POST /api/d7/search',
      results: 'POST /api/d7/results',
      fullSearch: 'POST /api/d7/full-search'
    },
    rateLimit: {
      windowMs: 15 * 60 * 1000,
      max: 100
    }
  });
});

// D7 Search Initiation Endpoint
app.post('/api/d7/search', validateSearchParams, async (req, res) => {
  try {
    const { niche, city, country } = req.body;
    
    console.log(`[${new Date().toISOString()}] Initiating D7 search:`, { niche, city, country });
    
    const searchParams = new URLSearchParams({
      keyword: niche.trim(),
      country: country.trim(),
      location: city.trim(),
      key: D7_API_KEY
    });
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    const searchResponse = await fetch(`${D7_BASE_URL}/search/?${searchParams}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'D7-Proxy-Server/1.0.0',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!searchResponse.ok) {
      const errorText = await searchResponse.text().catch(() => 'Unknown error');
      console.error(`D7 Search API error: ${searchResponse.status} - ${errorText}`);
      
      return res.status(searchResponse.status >= 500 ? 502 : searchResponse.status).json({
        error: 'D7 API Error',
        message: `Search initiation failed: ${searchResponse.status}`,
        details: searchResponse.status >= 400 && searchResponse.status < 500 ? 'Invalid request parameters' : 'External service unavailable'
      });
    }
    
    const searchData = await searchResponse.json();
    console.log(`[${new Date().toISOString()}] D7 search initiated successfully:`, {
      searchid: searchData.searchid,
      wait_seconds: searchData.wait_seconds
    });
    
    res.json({
      success: true,
      searchid: searchData.searchid,
      wait_seconds: searchData.wait_seconds,
      message: 'Search initiated successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const { statusCode, message } = handleApiError(error, 'D7 Search');
    res.status(statusCode).json({
      error: 'Search Failed',
      message,
      timestamp: new Date().toISOString()
    });
  }
});

// D7 Results Retrieval Endpoint
app.post('/api/d7/results', validateResultsParams, async (req, res) => {
  try {
    const { searchid, originalParams = {} } = req.body;
    
    console.log(`[${new Date().toISOString()}] Fetching D7 results for searchid:`, searchid);
    
    const resultsParams = new URLSearchParams({
      id: searchid.toString(),
      key: D7_API_KEY
    });
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 second timeout
    
    const resultsResponse = await fetch(`${D7_BASE_URL}/results/?${resultsParams}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'D7-Proxy-Server/1.0.0',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!resultsResponse.ok) {
      const errorText = await resultsResponse.text().catch(() => 'Unknown error');
      console.error(`D7 Results API error: ${resultsResponse.status} - ${errorText}`);
      
      return res.status(resultsResponse.status >= 500 ? 502 : resultsResponse.status).json({
        error: 'D7 API Error',
        message: `Results retrieval failed: ${resultsResponse.status}`,
        details: resultsResponse.status >= 400 && resultsResponse.status < 500 ? 'Invalid search ID or expired search' : 'External service unavailable'
      });
    }
    
    const resultsData = await resultsResponse.json();
    console.log(`[${new Date().toISOString()}] D7 results retrieved:`, {
      resultCount: Array.isArray(resultsData) ? resultsData.length : 'Unknown format'
    });
    
    const transformedResults = transformD7Results(resultsData, originalParams);
    
    res.json({
      success: true,
      results: transformedResults,
      count: transformedResults.length,
      searchid: searchid,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const { statusCode, message } = handleApiError(error, 'D7 Results');
    res.status(statusCode).json({
      error: 'Results Retrieval Failed',
      message,
      timestamp: new Date().toISOString()
    });
  }
});

// Full Search Endpoint (Search + Wait + Results)
app.post('/api/d7/full-search', validateSearchParams, async (req, res) => {
  try {
    const { niche, city, country } = req.body;
    const originalParams = { niche, city, country };
    
    console.log(`[${new Date().toISOString()}] Starting full D7 search:`, originalParams);
    
    // Step 1: Initiate search
    const searchParams = new URLSearchParams({
      keyword: niche.trim(),
      country: country.trim(),
      location: city.trim(),
      key: D7_API_KEY
    });
    
    let controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const searchResponse = await fetch(`${D7_BASE_URL}/search/?${searchParams}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'D7-Proxy-Server/1.0.0',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!searchResponse.ok) {
      const errorText = await searchResponse.text().catch(() => 'Unknown error');
      throw new Error(`Search initiation failed: ${searchResponse.status} - ${errorText}`);
    }
    
    const searchData = await searchResponse.json();
    const { searchid, wait_seconds } = searchData;
    const waitTime = parseInt(wait_seconds) || 30;
    
    console.log(`[${new Date().toISOString()}] Search initiated, waiting ${waitTime} seconds...`);
    
    // Step 2: Wait for the specified time
    await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
    
    // Step 3: Fetch results
    const resultsParams = new URLSearchParams({
      id: searchid.toString(),
      key: D7_API_KEY
    });
    
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 45000);
    
    const resultsResponse = await fetch(`${D7_BASE_URL}/results/?${resultsParams}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'D7-Proxy-Server/1.0.0',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!resultsResponse.ok) {
      const errorText = await resultsResponse.text().catch(() => 'Unknown error');
      throw new Error(`Results retrieval failed: ${resultsResponse.status} - ${errorText}`);
    }
    
    const resultsData = await resultsResponse.json();
    const transformedResults = transformD7Results(resultsData, originalParams);
    
    console.log(`[${new Date().toISOString()}] Full search completed:`, {
      searchid,
      resultCount: transformedResults.length
    });
    
    res.json({
      success: true,
      results: transformedResults,
      count: transformedResults.length,
      searchid: searchid,
      searchParams: originalParams,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const { statusCode, message } = handleApiError(error, 'D7 Full Search');
    res.status(statusCode).json({
      error: 'Full Search Failed',
      message,
      timestamp: new Date().toISOString()
    });
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableRoutes: [
      'GET /health',
      'GET /api/info',
      'POST /api/d7/search',
      'POST /api/d7/results',
      'POST /api/d7/full-search'
    ],
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 D7 Lead Finder Proxy Server is running!
📍 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
⏰ Started at: ${new Date().toISOString()}

Available endpoints:
• GET  /health              - Health check
• GET  /api/info           - API information
• POST /api/d7/search      - Initiate D7 search
• POST /api/d7/results     - Get search results
• POST /api/d7/full-search - Complete search process

🔧 Make sure to set these environment variables:
• D7_API_KEY (optional, has default)
• ALLOWED_ORIGINS (optional, defaults to localhost)
• NODE_ENV (optional, defaults to development)
  `);
});