# RKRT Agent Scraper

Automated scraper for Homes.com real estate agents. Saves data to the RKRT Supabase database.

## How It Works

1. **GitHub Actions** runs on a schedule (monthly on the 1st)
2. **Puppeteer** (headless Chrome) navigates to Homes.com
3. **Extracts** agent data: name, phone, brokerage, sales, photos
4. **Saves** to Supabase via the `save-agents` edge function

## Setup

### 1. Create GitHub Repository

```bash
gh repo create rkrt-agent-scraper --private
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/rkrt-agent-scraper.git
git push -u origin main
```

### 2. Add Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://usknntguurefeyzusbdh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service role key from Supabase dashboard |

### 3. Target Markets

The scraper reads from the `target_markets` table in Supabase. Add markets there:

```sql
INSERT INTO target_markets (city, state, priority, notes)
VALUES 
  ('The Woodlands', 'TX', 1, 'Rick Rannes market'),
  ('Chico', 'CA', 1, 'Sierra Haskins market');
```

## Manual Run

### Via GitHub Actions

1. Go to **Actions** tab
2. Select **Scrape Homes.com Agents**
3. Click **Run workflow**
4. Optionally enter a specific city/state

### Locally

```bash
npm install
export SUPABASE_SERVICE_ROLE_KEY=your-key
node scraper.js "The Woodlands" TX
```

## Data Fields Captured

| Field | Description |
|-------|-------------|
| name | Agent full name |
| brokerage | Company name |
| phone | Phone number |
| total_sales | Lifetime sales count |
| local_sales | Sales in this market |
| price_range_low | Minimum listing price |
| price_range_high | Maximum listing price |
| photo_url | Headshot URL |
| profile_url | Homes.com profile link |
| responds_quickly | Has "Responds Quickly" badge |
| has_video | Has video on profile |

## Rate Limiting

The scraper includes 5-second delays between pages to avoid being blocked. If rate-limited, it waits 30 seconds and retries.

## Costs

- **GitHub Actions**: Free (2000 minutes/month)
- **Supabase**: Included in your plan
- **Total**: $0/month
