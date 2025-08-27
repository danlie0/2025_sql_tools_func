# SQL Tools for Copilot Studio - Project Overview

## What We're Building

A conversational agent that lets users ask natural language questions about our database data through Microsoft Teams or Copilot Studio 365 chat, and get responses directly in the same interface.

## The Goal

Enable users to ask questions like:
- "How many people signed up yesterday?"
- "What's our revenue this month?"
- "Show me the top 5 countries by users"
- "How many active users do we have?"

And get instant, accurate answers from our database - **without giving users direct database access**.

## How It Works

```
User asks question in Teams/Copilot Studio 365 chat
        ↓
Copilot Studio understands the question
        ↓
Connectory routes the request
        ↓
Azure Function App generates and executes SQL
        ↓
Safe, read-only results returned to Teams/Copilot Studio 365 chat
        ↓
User sees formatted answer in the same chat interface
```

## Why This Approach?

✅ **Security First**: No direct database access for users  
✅ **Self-Service**: Users get answers instantly without bothering developers  
✅ **Safe Queries**: Only read-only operations on approved views  
✅ **Natural Language**: No need to learn SQL  
✅ **Audit Trail**: All queries are logged for monitoring  

## What We're NOT Building

❌ Any write operations (INSERT, UPDATE, DELETE)  
❌ Access to raw tables with sensitive data  
❌ Complex reporting or dashboards  
❌ Data export functionality  

## Success Looks Like

Users can have conversations in Teams or Copilot Studio 365 chat like:
> **User**: "How's our user growth this week?"  
> **Agent**: "We had 1,247 new signups this week, which is 23% higher than last week (1,012 signups)."

> **User**: "Which countries are our biggest markets?"  
> **Agent**: "Top 5 countries by active users: 1) United States (45,231), 2) United Kingdom (12,847), 3) Canada (8,932), 4) Australia (6,721), 5) Germany (5,483)."

Simple, conversational, and **safe** - all within the familiar chat interfaces users already use.
