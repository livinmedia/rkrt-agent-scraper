/**
 * RKRT Agent Scraper
 * 
 * Scrapes real estate agents from Homes.com and saves to RKRT database.
 * Designed to run in GitHub Actions with Puppeteer.
 * 
 * Usage:
 *   node scraper.js "The Woodlands" "TX"
 *   node scraper.js  # Scrapes all markets from target_markets table
 */

const puppeteer = require('puppeteer');

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://usknntguurefeyzusbdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAVE_ENDPOINT = `${SUPABASE_URL}/functions/v1/save-agents`;
const DELAY_BETWEEN_PAGES = 5000; // 5 seconds
const AGENTS_PER_PAGE = 48;
const MAX_PAGES = 150; // Safety limit

/**
 * Extract agents from a Homes.com page
 */
async function extractAgentsFromPage(page, city) {
  return await page.evaluate((cityName) => {
    const agents = [];
    const links = document.querySelectorAll('a[href*="/real-estate-agents/"][href$="/"]');
    
    links.forEach(link => {
      const href = link.getAttribute('href');
      const match = href.match(/\/real-estate-agents\/([a-z0-9-]+)\/([a-z0-9]+)\/$/);
      if (!match) return;
      
      const nameSlug = match[1];
      const agentId = match[2];
      
      // Skip city/state pages
      if (nameSlug.match(/-[a-z]{2}$/) || agentId.length < 4) return;
      
      const name = link.textContent.trim();
      if (!name || name.length < 3 || name.includes('Real Estate')) return;
      if (agents.find(a => a.name === name)) return;
      
      let card = link.closest('article') || link.parentElement?.parentElement?.parentElement?.parentElement;
      if (!card) return;
      
      const text = card.innerText || '';
      const html = card.innerHTML || '';
      
      // Extract data
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
      
      // Brokerage
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
      
      // Photo
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
 * Get total agent count from page
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
 * Scrape a single market
 */
async function scrapeMarket(browser, city, state) {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stateSlug = state.toLowerCase();
  const baseUrl = `https://www.homes.com/real-estate-agents/${citySlug}-${stateSlug}`;
  
  console.log(`\n🏠 Scraping ${city}, ${state}...`);
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  let allAgents = [];
  let savedCount = 0;
  
  try {
    // Page 1
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const totalAgents = await getTotalAgents(page);
    const totalPages = totalAgents ? Math.min(Math.ceil(totalAgents / AGENTS_PER_PAGE), MAX_PAGES) : MAX_PAGES;
    
    console.log(`📊 Total agents: ${totalAgents || 'unknown'}, Pages: ${totalPages}`);
    
    // Extract page 1
    const page1Agents = await extractAgentsFromPage(page, city);
    allAgents = allAgents.concat(page1Agents);
    console.log(`📄 Page 1/${totalPages}: ${page1Agents.length} agents`);
    
    // Remaining pages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
      
      try {
        await page.goto(`${baseUrl}/p${pageNum}/`, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Check for block
        const isBlocked = await page.evaluate(() => 
          document.body.innerText.includes('Access Denied') || 
          document.body.innerText.includes('blocked')
        );
        
        if (isBlocked) {
          console.log(`⚠️ Rate limited at page ${pageNum}. Waiting 30s...`);
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        
        const pageAgents = await extractAgentsFromPage(page, city);
        allAgents = allAgents.concat(pageAgents);
        
        if (pageNum % 10 === 0) {
          console.log(`📄 Page ${pageNum}/${totalPages}: ${pageAgents.length} agents (Total: ${allAgents.length})`);
        }
        
        // Save in batches of 200
        if (allAgents.length >= 200) {
          const saved = await saveAgents(allAgents, city, state);
          savedCount += saved;
          console.log(`💾 Saved batch: ${saved} agents`);
          allAgents = [];
        }
        
      } catch (err) {
        console.error(`❌ Page ${pageNum} error:`, err.message);
      }
    }
    
    // Save remaining
    if (allAgents.length > 0) {
      const saved = await saveAgents(allAgents, city, state);
      savedCount += saved;
    }
    
    console.log(`✅ ${city}, ${state}: ${savedCount} agents saved`);
    
  } catch (err) {
    console.error(`❌ Market error:`, err.message);
  } finally {
    await page.close();
  }
  
  return savedCount;
}

/**
 * Get target markets from Supabase
 */
async function getTargetMarkets() {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/target_markets?is_active=eq.true&select=city,state,priority`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    
    const markets = await response.json();
    return markets.sort((a, b) => a.priority - b.priority);
  } catch (err) {
    console.error('Failed to fetch target markets:', err.message);
    return [];
  }
}

/**
 * Main
 */
async function main() {
  console.log('🚀 RKRT Agent Scraper starting...\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  let totalSaved = 0;
  
  try {
    // Check for CLI arguments
    const args = process.argv.slice(2);
    
    if (args.length >= 2) {
      // Scrape specific market
      const [city, state] = args;
      totalSaved = await scrapeMarket(browser, city, state);
    } else {
      // Scrape all target markets
      const markets = await getTargetMarkets();
      
      if (markets.length === 0) {
        console.log('No target markets found. Add markets to target_markets table or pass city/state as arguments.');
        return;
      }
      
      console.log(`📋 Found ${markets.length} target markets`);
      
      for (const market of markets) {
        const saved = await scrapeMarket(browser, market.city, market.state);
        totalSaved += saved;
        
        // Delay between markets
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    
  } finally {
    await browser.close();
  }
  
  console.log(`\n🎉 Scrape complete! Total agents saved: ${totalSaved}`);
}

main().catch(console.error);
