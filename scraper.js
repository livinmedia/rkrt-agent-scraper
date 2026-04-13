/**
 * RKRT Agent Scraper
 * Scrapes real estate agents from Homes.com and saves to RKRT database.
 * Uses fetch-based scraping (no browser needed for GitHub Actions)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://usknntguurefeyzusbdh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAVE_ENDPOINT = `${SUPABASE_URL}/functions/v1/save-agents`;
const DELAY_BETWEEN_PAGES = 3000;
const AGENTS_PER_PAGE = 48;
const MAX_PAGES = 150;

/**
 * Parse HTML and extract agents
 */
function extractAgentsFromHTML(html, city) {
  const agents = [];
  
  // Find all agent profile links
  const linkRegex = /href="(\/real-estate-agents\/([a-z0-9-]+)\/([a-z0-9]+)\/)"/g;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    const [, href, nameSlug, agentId] = match;
    
    // Skip city/state pages
    if (nameSlug.match(/-[a-z]{2}$/) || agentId.length < 4) continue;
    
    // Find the agent card section around this link
    const linkPos = match.index;
    const cardStart = Math.max(0, html.lastIndexOf('<article', linkPos));
    const cardEnd = html.indexOf('</article>', linkPos);
    
    if (cardStart === -1 || cardEnd === -1) continue;
    
    const cardHtml = html.substring(cardStart, cardEnd + 10);
    
    // Extract name from the link text
    const nameMatch = cardHtml.match(new RegExp(`href="${href}"[^>]*>([^<]+)</a>`));
    const name = nameMatch ? nameMatch[1].trim() : null;
    
    if (!name || name.length < 3 || name.includes('Real Estate')) continue;
    if (agents.find(a => a.name === name)) continue;
    
    // Extract phone
    const phoneMatch = cardHtml.match(/\((\d{3})\)\s*(\d{3})[-\s]?(\d{4})/);
    const phone = phoneMatch ? `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}` : null;
    
    // Extract sales
    const totalMatch = cardHtml.match(/(\d+)\s*Total Sales/i);
    const localRegex = new RegExp(`(\\d+)\\s*in\\s*${city}`, 'i');
    const localMatch = cardHtml.match(localRegex);
    
    // Extract price range
    const priceMatch = cardHtml.match(/\$([\d,.]+[KM]?)\s*(?:-\s*\$([\d,.]+[KM]?))?\s*Price/i);
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
    
    // Extract brokerage (line after name)
    let brokerage = null;
    const brokerageMatch = cardHtml.match(new RegExp(`>${name}</a>\\s*</[^>]+>\\s*<[^>]+>([^<]+)</`, 'i'));
    if (brokerageMatch && brokerageMatch[1].length > 5 && brokerageMatch[1].length < 80) {
      brokerage = brokerageMatch[1].trim();
    }
    
    // Extract photo
    const imgMatch = cardHtml.match(/imagescdn\.homes\.com\/i2\/([^\/\"]+)\/(\d+)\/([^\.\"]+\.jpg)/);
    const photoUrl = imgMatch ? `https://imagescdn.homes.com/i2/${imgMatch[1]}/${imgMatch[2]}/${imgMatch[3]}` : null;
    
    agents.push({
      name,
      brokerage,
      phone,
      total_sales: totalMatch ? parseInt(totalMatch[1]) : null,
      local_sales: localMatch ? parseInt(localMatch[1]) : null,
      price_range_low: priceLow,
      price_range_high: priceHigh,
      photo_url: photoUrl,
      profile_url: `https://www.homes.com${href}`,
      homes_com_slug: agentId,
      responds_quickly: cardHtml.toLowerCase().includes('responds quickly'),
      has_video: cardHtml.toLowerCase().includes('play video')
    });
  }
  
  return agents;
}

/**
 * Get total agent count from HTML
 */
function getTotalAgentsFromHTML(html) {
  const match = html.match(/([\d,]+)\s*Real Estate Agents serving/i);
  return match ? parseInt(match[1].replace(/,/g, '')) : null;
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
 * Scrape a single market using fetch
 */
async function scrapeMarket(city, state) {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stateSlug = state.toLowerCase();
  const baseUrl = `https://www.homes.com/real-estate-agents/${citySlug}-${stateSlug}`;
  
  console.log(`\n🏠 Scraping ${city}, ${state}...`);
  
  let allAgents = [];
  let savedCount = 0;
  
  try {
    // Page 1
    const response1 = await fetch(`${baseUrl}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response1.ok) {
      console.log(`❌ Failed to fetch page 1: ${response1.status}`);
      return 0;
    }
    
    const html1 = await response1.text();
    const totalAgents = getTotalAgentsFromHTML(html1);
    const totalPages = totalAgents ? Math.min(Math.ceil(totalAgents / AGENTS_PER_PAGE), MAX_PAGES) : MAX_PAGES;
    
    console.log(`📊 Total agents: ${totalAgents || 'unknown'}, Pages: ${totalPages}`);
    
    const page1Agents = extractAgentsFromHTML(html1, city);
    allAgents = allAgents.concat(page1Agents);
    console.log(`📄 Page 1/${totalPages}: ${page1Agents.length} agents`);
    
    // Remaining pages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
      
      try {
        const response = await fetch(`${baseUrl}/p${pageNum}/`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        
        if (!response.ok) {
          if (response.status === 403) {
            console.log(`⚠️ Rate limited at page ${pageNum}. Waiting 30s...`);
            await new Promise(r => setTimeout(r, 30000));
            continue;
          }
          console.log(`⚠️ Page ${pageNum}: ${response.status}`);
          continue;
        }
        
        const html = await response.text();
        
        if (html.includes('Access Denied') || html.includes('blocked')) {
          console.log(`🚫 Rate limited at page ${pageNum}. Waiting 60s...`);
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        
        const pageAgents = extractAgentsFromHTML(html, city);
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
  
  let totalSaved = 0;
  
  const args = process.argv.slice(2);
  
  if (args.length >= 2) {
    const [city, state] = args;
    totalSaved = await scrapeMarket(city, state);
  } else {
    const markets = await getTargetMarkets();
    
    if (markets.length === 0) {
      console.log('No target markets found.');
      return;
    }
    
    console.log(`📋 Found ${markets.length} target markets`);
    
    for (const market of markets) {
      const saved = await scrapeMarket(market.city, market.state);
      totalSaved += saved;
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  
  console.log(`\n🎉 Scrape complete! Total agents saved: ${totalSaved}`);
}

main().catch(console.error);
