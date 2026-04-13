/**
 * RKRT Agent Scraper - Browserbase + Puppeteer
 * 
 * Uses Browserbase cloud browsers with Puppeteer to scrape Homes.com.
 * Browserbase provides residential IPs and anti-bot evasion.
 * 
 * Setup:
 *   npm install puppeteer-core
 * 
 * Usage:
 *   node scraper-browserbase.js "The Woodlands" TX
 *   node scraper-browserbase.js  # Scrapes all target markets
 * 
 * Environment variables:
 *   BROWSERBASE_API_KEY - Your Browserbase API key
 *   BROWSERBASE_PROJECT_ID - Your Browserbase project ID  
 *   SUPABASE_URL - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
 */

const puppeteer = require('puppeteer-core');

const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://usknntguurefeyzusbdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAVE_ENDPOINT = `${SUPABASE_URL}/functions/v1/save-agents`;

const DELAY_BETWEEN_PAGES = 4000;
const AGENTS_PER_PAGE = 48;
const MAX_PAGES = 150;

/**
 * Create a Browserbase session and return connection URL
 */
async function createSession() {
  const response = await fetch('https://www.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'x-bb-api-key': BROWSERBASE_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectId: BROWSERBASE_PROJECT_ID,
      browserSettings: {
        fingerprint: {
          devices: ['desktop'],
          locales: ['en-US'],
          operatingSystems: ['macos']
        }
      }
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create session: ${response.status} - ${error}`);
  }
  
  return await response.json();
}

/**
 * Extract agents from page using Puppeteer
 */
async function extractAgentsFromPage(page, city) {
  return await page.evaluate((cityName) => {
    const agents = [];
    const links = document.querySelectorAll('a[href*="/real-estate-agents/"][href$="/"]');
    
    links.forEach(link => {
      const href = link.getAttribute('href');
      const match = href.match(/\/real-estate-agents\/([a-z0-9-]+)\/([a-z0-9]+)\/$/);
      if (!match) return;
      
      const [, nameSlug, agentId] = match;
      if (nameSlug.match(/-[a-z]{2}$/) || agentId.length < 4) return;
      
      const name = link.textContent.trim();
      if (!name || name.length < 3 || name.includes('Real Estate')) return;
      if (agents.find(a => a.name === name)) return;
      
      let card = link.closest('article') || link.parentElement?.parentElement?.parentElement?.parentElement;
      if (!card) return;
      
      const text = card.innerText || '';
      const html = card.innerHTML || '';
      
      const phoneMatch = text.match(/\((\d{3})\)\s*(\d{3})[-\s]?(\d{4})/);
      const totalMatch = text.match(/(\d+)\s*Total Sales/i);
      const localRegex = new RegExp(`(\\d+)\\s*in\\s*${cityName}`, 'i');
      const localMatch = text.match(localRegex);
      
      const priceMatch = text.match(/\$([\d,.]+[KM]?)\s*(?:-\s*\$([\d,.]+[KM]?))?\s*Price/i);
      let priceLow = null, priceHigh = null;
      if (priceMatch) {
        const parseP = p => {
          if (!p) return null;
          const c = p.replace(/[$,]/g, '');
          if (c.endsWith('M')) return parseFloat(c) * 1000000;
          if (c.endsWith('K')) return parseFloat(c) * 1000;
          return parseFloat(c);
        };
        priceLow = parseP(priceMatch[1]);
        priceHigh = priceMatch[2] ? parseP(priceMatch[2]) : priceLow;
      }
      
      let brokerage = null;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === name && lines[i+1] && !lines[i+1].match(/^\(/) && !lines[i+1].match(/^\d+\s*(Total|in\s)/i)) {
          if (lines[i+1].length > 5 && lines[i+1].length < 80 && lines[i+1] !== 'RESPONDS QUICKLY') {
            brokerage = lines[i+1];
            break;
          }
        }
      }
      
      const imgMatch = html.match(/imagescdn\.homes\.com\/i2\/([^\/\"]+)\/(\d+)\/([^\.\"]+\.jpg)/);
      
      agents.push({
        name,
        brokerage,
        phone: phoneMatch ? `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}` : null,
        total_sales: totalMatch ? parseInt(totalMatch[1]) : null,
        local_sales: localMatch ? parseInt(localMatch[1]) : null,
        price_range_low: priceLow,
        price_range_high: priceHigh,
        photo_url: imgMatch ? `https://imagescdn.homes.com/i2/${imgMatch[1]}/${imgMatch[2]}/${imgMatch[3]}` : null,
        profile_url: `https://www.homes.com${href}`,
        homes_com_slug: agentId,
        responds_quickly: text.toLowerCase().includes('responds quickly'),
        has_video: html.toLowerCase().includes('play video')
      });
    });
    
    return agents;
  }, city);
}

/**
 * Get total agent count
 */
async function getTotalAgents(page) {
  return await page.evaluate(() => {
    const match = document.body.innerText.match(/([\d,]+)\s*Real Estate Agents serving/i);
    return match ? parseInt(match[1].replace(/,/g, '')) : null;
  });
}

/**
 * Save agents to Supabase
 */
async function saveAgents(agents, city, state) {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stateSlug = state.toLowerCase();
  
  const records = agents.map(a => ({
    ...a,
    city,
    state,
    source: 'homes.com',
    source_url: `https://www.homes.com/real-estate-agents/${citySlug}-${stateSlug}/`,
    last_scraped_at: new Date().toISOString()
  }));
  
  try {
    const response = await fetch(SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: records })
    });
    const data = await response.json();
    return data.saved || 0;
  } catch (err) {
    console.error('Save error:', err.message);
    return 0;
  }
}

/**
 * Scrape a market using Browserbase
 */
async function scrapeMarket(city, state) {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stateSlug = state.toLowerCase();
  const baseUrl = `https://www.homes.com/real-estate-agents/${citySlug}-${stateSlug}`;
  
  console.log(`\n🏠 Scraping ${city}, ${state}...`);
  
  let browser = null;
  let allAgents = [];
  let savedCount = 0;
  
  try {
    // Create Browserbase session
    console.log('🌐 Creating Browserbase session...');
    const session = await createSession();
    console.log(`✅ Session ID: ${session.id}`);
    
    // Connect Puppeteer to Browserbase
    const wsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${session.id}`;
    browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Navigate to first page
    console.log('📄 Loading page 1...');
    await page.goto(`${baseUrl}/`, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // Check for block
    const isBlocked = await page.evaluate(() => 
      document.body.innerText.includes('Access Denied') ||
      document.body.innerText.includes('blocked')
    );
    
    if (isBlocked) {
      console.log('🚫 Blocked on first page!');
      return 0;
    }
    
    const totalAgents = await getTotalAgents(page);
    const totalPages = totalAgents ? Math.min(Math.ceil(totalAgents / AGENTS_PER_PAGE), MAX_PAGES) : MAX_PAGES;
    
    console.log(`📊 Total: ${totalAgents || '?'} agents, ${totalPages} pages`);
    
    // Extract page 1
    const page1Agents = await extractAgentsFromPage(page, city);
    allAgents = allAgents.concat(page1Agents);
    console.log(`📄 Page 1/${totalPages}: ${page1Agents.length} agents`);
    
    // Scrape remaining pages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
      
      try {
        await page.goto(`${baseUrl}/p${pageNum}/`, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        
        const blocked = await page.evaluate(() =>
          document.body.innerText.includes('Access Denied')
        );
        
        if (blocked) {
          console.log(`🚫 Blocked at page ${pageNum}`);
          break;
        }
        
        const pageAgents = await extractAgentsFromPage(page, city);
        allAgents = allAgents.concat(pageAgents);
        
        if (pageNum % 10 === 0) {
          console.log(`📄 Page ${pageNum}/${totalPages}: ${pageAgents.length} agents (Total: ${allAgents.length})`);
        }
        
        // Save in batches
        if (allAgents.length >= 200) {
          const saved = await saveAgents(allAgents, city, state);
          savedCount += saved;
          console.log(`💾 Saved: ${saved} agents`);
          allAgents = [];
        }
        
      } catch (err) {
        console.error(`❌ Page ${pageNum}: ${err.message}`);
      }
    }
    
    // Save remaining
    if (allAgents.length > 0) {
      const saved = await saveAgents(allAgents, city, state);
      savedCount += saved;
    }
    
    console.log(`✅ ${city}, ${state}: ${savedCount} agents saved`);
    
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  return savedCount;
}

/**
 * Get target markets
 */
async function getTargetMarkets() {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/target_markets?is_active=eq.true&select=city,state,priority`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    return (await response.json()).sort((a, b) => a.priority - b.priority);
  } catch (err) {
    console.error('Failed to fetch markets:', err.message);
    return [];
  }
}

/**
 * Main
 */
async function main() {
  console.log('🚀 RKRT Agent Scraper (Browserbase) starting...\n');
  
  if (!BROWSERBASE_API_KEY) {
    console.error('❌ BROWSERBASE_API_KEY not set');
    process.exit(1);
  }
  if (!BROWSERBASE_PROJECT_ID) {
    console.error('❌ BROWSERBASE_PROJECT_ID not set');
    process.exit(1);
  }
  
  const args = process.argv.slice(2);
  let totalSaved = 0;
  
  if (args.length >= 2) {
    totalSaved = await scrapeMarket(args[0], args[1]);
  } else {
    const markets = await getTargetMarkets();
    console.log(`📋 ${markets.length} target markets`);
    
    for (const m of markets) {
      totalSaved += await scrapeMarket(m.city, m.state);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  console.log(`\n🎉 Done! Total saved: ${totalSaved}`);
}

main().catch(console.error);
