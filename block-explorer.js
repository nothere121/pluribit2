import express from 'express';

const app = express();
const PORT = process.env.EXPLORER_PORT || 3000;
const NODE_API = process.env.NODE_API_URL || 'http://localhost:3001';

app.use(express.static('public'));

// API proxy endpoints (unchanged)
app.get('/api/stats', async (req, res) => {
    try {
        const response = await fetch(`${NODE_API}/api/stats`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to connect to node' });
    }
});

app.get('/api/blocks/recent', async (req, res) => {
    try {
        const count = req.query.count || 20;
        const response = await fetch(`${NODE_API}/api/blocks/recent?count=${count}`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load blocks' });
    }
});

app.get('/api/block/:height', async (req, res) => {
    try {
        const response = await fetch(`${NODE_API}/api/block/${req.params.height}`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load block' });
    }
});

app.get('/api/block/hash/:hash', async (req, res) => {
    try {
        const response = await fetch(`${NODE_API}/api/block/hash/${req.params.hash}`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(404).json({ error: 'Block not found' });
    }
});

app.get('/api/metrics/difficulty', async (req, res) => {
    try {
        const response = await fetch(`${NODE_API}/api/metrics/difficulty`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load difficulty metrics' });
    }
});

app.get('/api/metrics/rewards', async (req, res) => {
    try {
        const response = await fetch(`${NODE_API}/api/metrics/rewards`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load reward metrics' });
    }
});

app.get('/api/metrics/supply', async (req, res) => {
    try {
        const response = await fetch(`${NODE_API}/api/metrics/supply`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load supply metrics' });
    }
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pluriƀit Explorer</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --bg: #0a0a0f;
            --surface: #15151f;
            --surface-hover: #1a1a28;
            --border: #252530;
            --text: #e8e8f0;
            --text-dim: #9090a8;
            --accent: #4ECDC4;
            --accent-hover: #3dbdb5;
            --accent-dim: #2a9d96;
            --accent-red: #FF6B6B;
            --success: #22c55e;
        }

        [data-theme="light"] {
            --bg: #F0F4F8;
            --surface: #FFFFFF;
            --surface-hover: #e8ecf0;
            --border: #D3D9E2;
            --text: #293241;
            --text-dim: #6c757d;
            --accent: #4ECDC4;
            --accent-hover: #3dbdb5;
            --accent-dim: #2a9d96;
            --accent-red: #FF6B6B;
            --success: #22c55e;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.6;
            transition: background 0.3s, color 0.3s;
        }

        .header {
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            padding: 1rem 0;
            position: sticky;
            top: 0;
            z-index: 100;
            backdrop-filter: blur(10px);
        }

        .nav {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 1.5rem;
            display: flex;
            align-items: center;
            gap: 2rem;
        }

        .logo {
            font-size: 1.25rem;
            font-weight: 700;
            color: var(--accent);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .search-box {
            flex: 1;
            max-width: 500px;
            position: relative;
        }

        .search-input {
            width: 100%;
            padding: 0.625rem 2.5rem 0.625rem 1rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text);
            font-size: 0.875rem;
            font-family: 'Inter', sans-serif;
            transition: all 0.2s;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--accent);
        }

        .search-input::placeholder {
            color: var(--text-dim);
        }

        .search-btn {
            position: absolute;
            right: 0.5rem;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-dim);
            cursor: pointer;
            padding: 0.25rem 0.5rem;
        }

        .nav-actions {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .theme-toggle {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 0.5rem 0.75rem;
            cursor: pointer;
            color: var(--text);
            font-size: 1.125rem;
            transition: all 0.2s;
        }

        .theme-toggle:hover {
            border-color: var(--accent);
        }

        .status-badge {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 0.875rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            font-size: 0.875rem;
            font-weight: 600;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--success);
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem 1.5rem;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .stat-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1.25rem;
            transition: border-color 0.2s;
        }

        .stat-card:hover {
            border-color: var(--accent-dim);
        }

        .stat-label {
            color: var(--text-dim);
            font-size: 0.8125rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .stat-value {
            font-size: 1.75rem;
            font-weight: 700;
            color: var(--accent);
            font-variant-numeric: tabular-nums;
        }

        .block-train-section {
            margin-bottom: 2rem;
            overflow: hidden;
            position: relative;
        }

        .block-train-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .train-title {
            font-size: 1rem;
            font-weight: 700;
            color: var(--text);
        }

        .block-train-container {
            position: relative;
            height: 120px;
            overflow: hidden;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1rem;
        }

        .block-train {
            display: flex;
            gap: 1rem;
            position: absolute;
            left: 0;
            transition: transform 0.5s ease-out;
        }

        .train-block {
            flex-shrink: 0;
            width: 200px;
            background: var(--bg);
            border: 2px solid var(--accent);
            border-radius: 6px;
            padding: 0.75rem;
            cursor: pointer;
            transition: all 0.3s;
            animation: slideIn 0.5s ease-out;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateX(-50px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        .train-block:hover {
            border-color: var(--accent-hover);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(78, 205, 196, 0.3);
        }

        .train-block.new {
            animation: newBlock 0.6s ease-out;
            border-color: var(--success);
        }

        @keyframes newBlock {
            0% {
                transform: scale(1.1);
                border-color: var(--success);
            }
            100% {
                transform: scale(1);
                border-color: var(--accent);
            }
        }

        .train-block-height {
            font-size: 1.125rem;
            font-weight: 700;
            color: var(--accent);
            margin-bottom: 0.25rem;
        }

        .train-block-time {
            font-size: 0.75rem;
            color: var(--text-dim);
            margin-bottom: 0.5rem;
        }

        .train-block-txs {
            font-size: 0.75rem;
            color: var(--text-dim);
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }

        .chart-container {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 2rem;
        }

        .chart-header {
            margin-bottom: 1.5rem;
        }

        .chart-title {
            font-size: 1rem;
            font-weight: 700;
            color: var(--text);
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .section-title {
            font-size: 1.125rem;
            font-weight: 700;
        }

        .blocks-container {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .block-row {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1rem;
            cursor: pointer;
            transition: all 0.2s;
        }

        .block-row:hover {
            border-color: var(--accent);
            transform: translateX(2px);
        }

        .block-main {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.75rem;
        }

        .block-height {
            font-size: 1.125rem;
            font-weight: 700;
            color: var(--accent);
        }

        .block-time {
            color: var(--text-dim);
            font-size: 0.8125rem;
        }

        .block-info {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 1rem;
        }

        .info-item {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .info-label {
            color: var(--text-dim);
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .info-value {
            font-family: 'Courier New', monospace;
            font-size: 0.8125rem;
            color: var(--text);
            word-break: break-all;
        }

        .tx-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.375rem;
            padding: 0.25rem 0.625rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--text-dim);
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(4px);
            z-index: 1000;
            padding: 2rem;
            overflow-y: auto;
        }

        .modal.active {
            display: flex;
            align-items: start;
            justify-content: center;
            padding-top: 4rem;
        }

        .modal-content {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            max-width: 800px;
            width: 100%;
            max-height: calc(100vh - 8rem);
            overflow-y: auto;
        }

        .modal-header {
            padding: 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            background: var(--surface);
            z-index: 1;
        }

        .modal-title {
            font-size: 1.25rem;
            font-weight: 700;
        }

        .close-btn {
            background: none;
            border: none;
            color: var(--text-dim);
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .close-btn:hover {
            background: var(--bg);
            color: var(--accent-red);
        }

        .modal-body {
            padding: 1.5rem;
        }

        .detail-section {
            margin-bottom: 1.5rem;
        }

        .detail-section:last-child {
            margin-bottom: 0;
        }

        .detail-section-title {
            font-weight: 700;
            margin-bottom: 0.75rem;
            color: var(--accent);
            font-size: 0.875rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .detail-grid {
            display: grid;
            gap: 0.75rem;
        }

        .detail-row {
            display: grid;
            grid-template-columns: 140px 1fr;
            gap: 1rem;
        }

        .detail-key {
            color: var(--text-dim);
            font-size: 0.8125rem;
            font-weight: 600;
        }

        .detail-val {
            font-family: 'Courier New', monospace;
            font-size: 0.8125rem;
            word-break: break-all;
        }

        .code-block {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 1rem;
            overflow-x: auto;
            font-family: 'Courier New', monospace;
            font-size: 0.75rem;
            line-height: 1.5;
            color: var(--text-dim);
        }

        .loading {
            text-align: center;
            padding: 3rem;
            color: var(--text-dim);
        }

        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 1rem;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        @media (max-width: 768px) {
            .nav {
                flex-wrap: wrap;
                gap: 1rem;
            }

            .search-box {
                order: 3;
                max-width: 100%;
                flex-basis: 100%;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            .detail-row {
                grid-template-columns: 1fr;
                gap: 0.25rem;
            }

            .train-block {
                width: 160px;
            }
        }
    </style>
</head>
<body>
    <header class="header">
        <nav class="nav">
            <div class="logo">
                 Pluriƀit Explorer
            </div>
            <div class="search-box">
                <input 
                    type="text" 
                    class="search-input" 
                    id="searchInput"
                    placeholder="Search by block height or hash..."
                />
                <button class="search-btn" onclick="performSearch()">🔍</button>
            </div>
            <div class="nav-actions">
                <button class="theme-toggle" onclick="toggleTheme()" id="themeToggle">
                    🌙
                </button>
                <div class="status-badge">
                    <div class="status-dot"></div>
                    <span>Live</span>
                </div>
            </div>
        </nav>
    </header>

    <main class="container">
        <section class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Height</div>
                <div class="stat-value" id="height">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Work</div>
                <div class="stat-value" id="work">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">UTXO Set</div>
                <div class="stat-value" id="utxo">-</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Block Time</div>
                <div class="stat-value" id="blockTime">-</div>
            </div>
        </section>

        <section class="block-train-section">
            <div class="block-train-header">
                <h2 class="train-title">Latest Blocks</h2>
            </div>
            <div class="block-train-container">
                <div class="block-train" id="blockTrain"></div>
            </div>
        </section>

        <section class="chart-container">
            <div class="chart-header">
                <h2 class="chart-title">Block Height Over Time</h2>
            </div>
            <canvas id="blockChart" height="80"></canvas>
        </section>

        <section class="chart-container">
            <div class="chart-header">
                <h2 class="chart-title">Mining Difficulty (VRF Threshold & VDF Iterations)</h2>
            </div>
            <canvas id="difficultyChart" height="80"></canvas>
        </section>

        <section class="chart-container">
            <div class="chart-header">
                <h2 class="chart-title">Block Rewards</h2>
            </div>
            <canvas id="rewardChart" height="80"></canvas>
        </section>

        <section class="chart-container">
            <div class="chart-header">
                <h2 class="chart-title">Supply & Stock-to-Flow</h2>
            </div>
            <canvas id="supplyChart" height="80"></canvas>
        </section>

        <section>
            <div class="section-header">
                <h2 class="section-title">Recent Blocks</h2>
            </div>
            <div class="blocks-container" id="blocksContainer">
                <div class="loading">
                    <div class="spinner"></div>
                    <p>Loading blocks...</p>
                </div>
            </div>
        </section>
    </main>

    <div class="modal" id="blockModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 class="modal-title" id="modalTitle">Block Details</h2>
                <button class="close-btn" onclick="closeModal()">×</button>
            </div>
            <div class="modal-body" id="modalBody"></div>
        </div>
    </div>

    <script>
        let state = {
            blocks: [],
            stats: {},
            charts: {},
            lastBlockHeight: 0
        };

        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            document.getElementById('themeToggle').textContent = newTheme === 'dark' ? '🌙' : '☀️';
            
            if (state.charts.block) updateChartTheme(newTheme);
            if (state.charts.difficulty) updateDifficultyChartTheme(newTheme);
            if (state.charts.reward) updateRewardChartTheme(newTheme);
            if (state.charts.supply) updateSupplyChartTheme(newTheme);
        }

        function initTheme() {
            const savedTheme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            document.getElementById('themeToggle').textContent = savedTheme === 'dark' ? '🌙' : '☀️';
        }

        function getChartColors(theme) {
            return {
                gridColor: theme === 'dark' ? '#252530' : '#D3D9E2',
                textColor: theme === 'dark' ? '#9090a8' : '#6c757d',
                accentColor: '#4ECDC4'
            };
        }

        function updateChartTheme(theme) {
            const colors = getChartColors(theme);
            
            state.charts.block.options.scales.y.ticks.color = colors.textColor;
            state.charts.block.options.scales.y.grid.color = colors.gridColor;
            state.charts.block.options.scales.x.ticks.color = colors.textColor;
            state.charts.block.options.scales.x.grid.color = colors.gridColor;
            state.charts.block.data.datasets[0].borderColor = colors.accentColor;
            state.charts.block.data.datasets[0].backgroundColor = colors.accentColor + '1a';
            state.charts.block.update('none');
        }

        function updateDifficultyChartTheme(theme) {
            const colors = getChartColors(theme);
            
            state.charts.difficulty.options.scales.y.ticks.color = colors.textColor;
            state.charts.difficulty.options.scales.y.grid.color = colors.gridColor;
            state.charts.difficulty.options.scales.y1.ticks.color = colors.textColor;
            state.charts.difficulty.options.scales.y1.grid.color = colors.gridColor;
            state.charts.difficulty.options.scales.x.ticks.color = colors.textColor;
            state.charts.difficulty.options.scales.x.grid.color = colors.gridColor;
            state.charts.difficulty.options.plugins.legend.labels.color = colors.textColor;
            state.charts.difficulty.update('none');
        }

        function updateRewardChartTheme(theme) {
            const colors = getChartColors(theme);
            
            state.charts.reward.options.scales.y.ticks.color = colors.textColor;
            state.charts.reward.options.scales.y.grid.color = colors.gridColor;
            state.charts.reward.options.scales.y.title.color = colors.textColor;
            state.charts.reward.options.scales.x.ticks.color = colors.textColor;
            state.charts.reward.options.scales.x.grid.color = colors.gridColor;
            state.charts.reward.update('none');
        }

        function updateSupplyChartTheme(theme) {
            const colors = getChartColors(theme);
            
            state.charts.supply.options.scales.y.ticks.color = colors.textColor;
            state.charts.supply.options.scales.y.grid.color = colors.gridColor;
            state.charts.supply.options.scales.y.title.color = colors.textColor;
            state.charts.supply.options.scales.y1.ticks.color = colors.textColor;
            state.charts.supply.options.scales.y1.title.color = colors.textColor;
            state.charts.supply.options.scales.x.ticks.color = colors.textColor;
            state.charts.supply.options.scales.x.grid.color = colors.gridColor;
            state.charts.supply.options.plugins.legend.labels.color = colors.textColor;
            state.charts.supply.update('none');
        }

        async function init() {
            initTheme();
            await loadStats();
            await loadBlocks();
            initCharts();
            await loadDifficultyMetrics();
            await loadRewardMetrics();
            await loadSupplyMetrics();
            startAutoRefresh();
        }

        function initCharts() {
            const ctx = document.getElementById('blockChart');
            const theme = document.documentElement.getAttribute('data-theme') || 'dark';
            const colors = getChartColors(theme);
            
            state.charts.block = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Block Height',
                        data: [],
                        borderColor: colors.accentColor,
                        backgroundColor: colors.accentColor + '1a',
                        tension: 0.3,
                        fill: true,
                        pointRadius: 0,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: {
                            ticks: { color: colors.textColor },
                            grid: { color: colors.gridColor }
                        },
                        x: {
                            ticks: { color: colors.textColor, maxRotation: 0 },
                            grid: { color: colors.gridColor }
                        }
                    }
                }
            });
            updateChart();
        }

        function updateChart() {
            if (!state.charts.block || state.blocks.length === 0) return;
            
            const blocks = state.blocks.slice(0, 20).reverse();
            state.charts.block.data.labels = blocks.map(b => '#' + b.height);
            state.charts.block.data.datasets[0].data = blocks.map(b => b.height);
            state.charts.block.update('none');
        }

        async function loadStats() {
            try {
                const res = await fetch('/api/stats');
                const stats = await res.json();
                
                document.getElementById('height').textContent = stats.height.toLocaleString();
                document.getElementById('work').textContent = formatNumber(stats.totalWork);
                document.getElementById('utxo').textContent = stats.utxoCount.toLocaleString();
                
                state.stats = stats;
            } catch (e) {
                console.error('Failed to load stats:', e);
            }
        }

        async function loadBlocks() {
            try {
                const res = await fetch('/api/blocks/recent?count=20');
                const blocks = await res.json();
                
                if (blocks.length > 0 && blocks[0].height > state.lastBlockHeight) {
                    state.lastBlockHeight = blocks[0].height;
                    if (state.blocks.length > 0) {
                        updateBlockTrain(blocks[0], true);
                    }
                }
                
                state.blocks = blocks;
                renderBlocks(blocks);
                updateChart();
                updateBlockTime(blocks);
                updateBlockTrain(null, false);
            } catch (e) {
                console.error('Failed to load blocks:', e);
                document.getElementById('blocksContainer').innerHTML = 
                    '<div class="loading"><p style="color: var(--text-dim);">Failed to load blocks</p></div>';
            }
        }

        function updateBlockTime(blocks) {
            if (blocks.length < 2) {
                document.getElementById('blockTime').textContent = '~2m';
                return;
            }
            
            const recentBlocks = blocks.slice(0, Math.min(10, blocks.length));
            let totalTimeDiff = 0;
            let count = 0;
            
            for (let i = 0; i < recentBlocks.length - 1; i++) {
                const timeDiff = recentBlocks[i].timestamp - recentBlocks[i + 1].timestamp;
                totalTimeDiff += timeDiff;
                count++;
            }
            
            if (count > 0) {
                const avgTimeMs = totalTimeDiff / count;
                const avgTimeSec = Math.round(avgTimeMs / 1000);
                
                if (avgTimeSec < 60) {
                    document.getElementById('blockTime').textContent = avgTimeSec + 's';
                } else {
                    const minutes = Math.floor(avgTimeSec / 60);
                    const seconds = avgTimeSec % 60;
                    document.getElementById('blockTime').textContent = 
                        seconds > 0 ? (minutes + 'm ' + seconds + 's') : (minutes + 'm');
                }
            }
        }

        function updateBlockTrain(newBlock, isNew) {
            const train = document.getElementById('blockTrain');
            
            if (isNew && newBlock) {
                const blockEl = createTrainBlock(newBlock, true);
                train.insertBefore(blockEl, train.firstChild);
                
                while (train.children.length > 10) {
                    train.removeChild(train.lastChild);
                }
                
                setTimeout(() => {
                    blockEl.classList.remove('new');
                }, 600);
            } else {
                train.innerHTML = '';
                const blocksToShow = state.blocks.slice(0, 10);
                blocksToShow.forEach(block => {
                    train.appendChild(createTrainBlock(block, false));
                });
            }
        }

        function createTrainBlock(block, isNew) {
            const div = document.createElement('div');
            div.className = 'train-block' + (isNew ? ' new' : '');
            div.onclick = () => viewBlock(block.height);
            div.innerHTML =
                '<div class="train-block-height">#' + block.height.toLocaleString() + '</div>' +
                '<div class="train-block-time">' + formatTime(block.timestamp) + '</div>' +
                '<div class="train-block-txs">' + block.txCount + ' tx</div>';
            return div;
        }

        async function loadDifficultyMetrics() {
            try {
                const res = await fetch('/api/metrics/difficulty');
                const metrics = await res.json();
                
                const ctx = document.getElementById('difficultyChart');
                const theme = document.documentElement.getAttribute('data-theme') || 'dark';
                const colors = getChartColors(theme);
                
                const vrfData = metrics.map(m => {
                    const bytes = new Uint8Array(m.vrfThreshold);
                    return parseInt(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8), 16);
                });
                
                state.charts.difficulty = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: metrics.map(m => '#' + m.height),
                        datasets: [
                            {
                                label: 'VRF Threshold (Lower = Harder)',
                                data: vrfData,
                                borderColor: '#22c55e',
                                backgroundColor: 'rgba(34, 197, 94, 0.1)',
                                yAxisID: 'y',
                                tension: 0.3,
                                fill: true,
                                pointRadius: 0,
                                borderWidth: 2
                            },
                            {
                                label: 'VDF Iterations',
                                data: metrics.map(m => m.vdfIterations),
                                borderColor: '#f59e0b',
                                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                                yAxisID: 'y1',
                                tension: 0.3,
                                fill: true,
                                pointRadius: 0,
                                borderWidth: 2
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        interaction: {
                            mode: 'index',
                            intersect: false,
                        },
                        plugins: {
                            legend: { 
                                display: true,
                                labels: {
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                type: 'linear',
                                display: true,
                                position: 'left',
                                ticks: { color: colors.textColor },
                                grid: { color: colors.gridColor },
                                title: {
                                    display: true,
                                    text: 'VRF Threshold',
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            },
                            y1: {
                                type: 'linear',
                                display: true,
                                position: 'right',
                                ticks: { color: colors.textColor },
                                grid: { drawOnChartArea: false },
                                title: {
                                    display: true,
                                    text: 'VDF Iterations',
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            },
                            x: {
                                ticks: { 
                                    color: colors.textColor,
                                    maxRotation: 45,
                                    minRotation: 45
                                },
                                grid: { color: colors.gridColor }
                            }
                        }
                    }
                });
            } catch (e) {
                console.error('Failed to load difficulty metrics:', e);
            }
        }

        async function loadRewardMetrics() {
            try {
                const res = await fetch('/api/metrics/rewards');
                const rewards = await res.json();
                
                const ctx = document.getElementById('rewardChart');
                const theme = document.documentElement.getAttribute('data-theme') || 'dark';
                const colors = getChartColors(theme);
                
                state.charts.reward = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: rewards.map(r => '#' + r.height),
                        datasets: [{
                            label: 'Block Reward (ƀ)',
                            data: rewards.map(r => r.reward / 100_000_000),
                            borderColor: '#8b5cf6',
                            backgroundColor: 'rgba(139, 92, 246, 0.1)',
                            tension: 0.1,
                            fill: true,
                            pointRadius: 0,
                            borderWidth: 2,
                            stepped: true
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: { display: false }
                        },
                        scales: {
                            y: {
                                ticks: { color: colors.textColor },
                                grid: { color: colors.gridColor },
                                title: {
                                    display: true,
                                    text: 'Reward (ƀ)',
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            },
                            x: {
                                ticks: { 
                                    color: colors.textColor,
                                    maxRotation: 45,
                                    minRotation: 45
                                },
                                grid: { color: colors.gridColor }
                            }
                        }
                    }
                });
            } catch (e) {
                console.error('Failed to load reward metrics:', e);
            }
        }

        async function loadSupplyMetrics() {
            try {
                const res = await fetch('/api/metrics/supply');
                const supply = await res.json();
                
                const ctx = document.getElementById('supplyChart');
                const theme = document.documentElement.getAttribute('data-theme') || 'dark';
                const colors = getChartColors(theme);
                
                state.charts.supply = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: ['Current'],
                        datasets: [
                            {
                                label: 'Total Supply (ƀ)',
                                data: [supply.supplyInCoins],
                                borderColor: '#06b6d4',
                                backgroundColor: 'rgba(6, 182, 212, 0.1)',
                                yAxisID: 'y',
                                fill: true,
                                pointRadius: 5,
                                borderWidth: 2
                            },
                            {
                                label: 'Stock-to-Flow Ratio',
                                data: [supply.stockToFlow],
                                borderColor: '#ec4899',
                                backgroundColor: 'rgba(236, 72, 153, 0.1)',
                                yAxisID: 'y1',
                                fill: true,
                                pointRadius: 5,
                                borderWidth: 2
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: { 
                                display: true,
                                labels: {
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        let label = context.dataset.label || '';
                                        if (label) {
                                            label += ': ';
                                        }
                                        if (context.parsed.y !== null) {
                                            if (context.datasetIndex === 0) {
                                                label += context.parsed.y.toLocaleString(undefined, {
                                                    minimumFractionDigits: 2,
                                                    maximumFractionDigits: 2
                                                });
                                            } else {
                                                label += context.parsed.y.toFixed(2);
                                            }
                                        }
                                        return label;
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                type: 'linear',
                                display: true,
                                position: 'left',
                                ticks: { color: colors.textColor },
                                grid: { color: colors.gridColor },
                                title: {
                                    display: true,
                                    text: 'Supply (ƀ)',
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            },
                            y1: {
                                type: 'linear',
                                display: true,
                                position: 'right',
                                ticks: { color: colors.textColor },
                                grid: { drawOnChartArea: false },
                                title: {
                                    display: true,
                                    text: 'Stock-to-Flow',
                                    color: colors.textColor,
                                    font: {
                                        family: 'Inter',
                                        weight: 600
                                    }
                                }
                            },
                            x: {
                                ticks: { color: colors.textColor },
                                grid: { color: colors.gridColor }
                            }
                        }
                    }
                });
            } catch (e) {
                console.error('Failed to load supply metrics:', e);
            }
        }

        function renderBlocks(blocks) {
            const container = document.getElementById('blocksContainer');
            
            if (blocks.length === 0) {
                container.innerHTML = '<div class="loading"><p>No blocks found</p></div>';
                return;
            }
            
            container.innerHTML = blocks.map(block => {
                return '<div class="block-row" onclick="viewBlock(' + block.height + ')">' +
                    '<div class="block-main">' +
                        '<div>' +
                            '<div class="block-height">#' + block.height.toLocaleString() + '</div>' +
                            '<div class="block-time">' + formatTime(block.timestamp) + '</div>' +
                        '</div>' +
                        '<div class="tx-badge">' +
                            block.txCount + ' tx' +
                        '</div>' +
                    '</div>' +
                    '<div class="block-info">' +
                        '<div class="info-item">' +
                            '<div class="info-label">Hash</div>' +
                            '<div class="info-value">' + truncateHash(block.hash) + '</div>' +
                        '</div>' +
                        '<div class="info-item">' +
                            '<div class="info-label">Miner</div>' +
                            '<div class="info-value">' + block.miner + '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        async function viewBlock(height) {
            const modal = document.getElementById('blockModal');
            const modalTitle = document.getElementById('modalTitle');
            const modalBody = document.getElementById('modalBody');
            
            modalTitle.textContent = 'Block #' + height;
            modalBody.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading...</p></div>';
            modal.classList.add('active');
            
            try {
                const res = await fetch('/api/block/' + height);
                if (!res.ok) throw new Error('Block not found');
                const block = await res.json();
                
                modalBody.innerHTML = 
                    '<div class="detail-section">' +
                        '<div class="detail-section-title">Block Information</div>' +
                        '<div class="detail-grid">' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">Height</div>' +
                                '<div class="detail-val">' + block.height.toLocaleString() + '</div>' +
                            '</div>' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">Hash</div>' +
                                '<div class="detail-val">' + block.hash + '</div>' +
                            '</div>' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">Previous Hash</div>' +
                                '<div class="detail-val">' + block.prevHash + '</div>' +
                            '</div>' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">Timestamp</div>' +
                                '<div class="detail-val">' + new Date(block.timestamp).toLocaleString() + '</div>' +
                            '</div>' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">Transactions</div>' +
                                '<div class="detail-val">' + (block.transactions ? block.transactions.length : 0) + '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="detail-section">' +
                        '<div class="detail-section-title">Consensus Data</div>' +
                        '<div class="detail-grid">' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">VDF Iterations</div>' +
                                '<div class="detail-val">' + (block.vdfIterations ? block.vdfIterations.toLocaleString() : 'N/A') + '</div>' +
                            '</div>' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">VRF Threshold</div>' +
                                '<div class="detail-val">' + (block.vrfThreshold ? truncateHash(JSON.stringify(block.vrfThreshold)) : 'N/A') + '</div>' +
                            '</div>' +
                            '<div class="detail-row">' +
                                '<div class="detail-key">Lottery Nonce</div>' +
                                '<div class="detail-val">' + (block.lotteryNonce || 'N/A') + '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="detail-section">' +
                        '<div class="detail-section-title">Raw Data</div>' +
                        '<div class="code-block">' + JSON.stringify(block, null, 2) + '</div>' +
                    '</div>';
            } catch (e) {
                modalBody.innerHTML = '<div class="loading"><p style="color: var(--text-dim);">Failed to load block: ' + e.message + '</p></div>';
            }
        }

        function closeModal() {
            document.getElementById('blockModal').classList.remove('active');
        }

        async function performSearch() {
            const query = document.getElementById('searchInput').value.trim();
            if (!query) return;
            
            if (/^\d+$/.test(query)) {
                viewBlock(parseInt(query));
                return;
            }
            
            try {
                const res = await fetch('/api/block/hash/' + query);
                if (res.ok) {
                    const block = await res.json();
                    viewBlock(block.height);
                } else {
                    alert('Block not found');
                }
            } catch (e) {
                alert('Search failed: ' + e.message);
            }
        }

        function startAutoRefresh() {
            setInterval(async () => {
                await loadStats();
                await loadBlocks();
            }, 10000);
        }

        function formatNumber(num) {
            if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
            if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
            if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
            return num.toString();
        }

        function truncateHash(hash) {
            if (!hash) return 'N/A';
            if (hash.length < 20) return hash;
            return hash.substring(0, 12) + '...' + hash.substring(hash.length - 8);
        }

        function formatTime(timestamp) {
            const now = Date.now();
            const diff = now - timestamp;
            const seconds = Math.floor(diff / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            
            if (hours > 0) return hours + 'h ago';
            if (minutes > 0) return minutes + 'm ago';
            return seconds + 's ago';
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });

        document.getElementById('blockModal').addEventListener('click', (e) => {
            if (e.target.id === 'blockModal') closeModal();
        });

        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });

        init();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`🔍 Pluriƀit Block Explorer running on http://localhost:${PORT}`);
    console.log(`📡 Connected to node at ${NODE_API}`);
});
