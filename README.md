# Chat Summary

A Node.js application that analyzes chat messages and sends them to an analysis endpoint.

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
# Database configuration
DB_PATH=./data.db

# Analysis API configuration
ANALYSIS_ENDPOINT=https://your-analysis-api.com/endpoint
ANALYSIS_API_KEY=your-api-key-here
```

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

## Required Environment Variables

- `ANALYSIS_ENDPOINT`: The API endpoint URL where chat analysis data will be sent
- `ANALYSIS_API_KEY`: (Optional) API key for authentication with the analysis endpoint
- `DB_PATH`: (Optional) Path to the SQLite database file (defaults to `./data.db`)
