# Production Deployment Guide

## ⚠️ Important Security & Data Considerations

### Data Persistence Warning
**This application uses SQLite in-memory database as specified in requirements.** 
- All data will be lost when the server restarts
- Not suitable for production use without modification
- For production, consider switching to file-based SQLite or a proper database

### Authentication Security
- Email-only authentication assumes trusted network environment
- No password protection - anyone with a valid company email can access
- Consider integrating with company SSO for production use
- JWT tokens expire after 24 hours

## Environment Configuration

1. **Copy environment variables:**
```bash
cp .env.example .env
```

2. **Set strong JWT secret:**
```bash
# Generate a secure random secret (32+ characters recommended)
JWT_SECRET=$(openssl rand -base64 32)
```

3. **Update .env file:**
```bash
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://your-frontend-domain.com
JWT_SECRET=your-generated-secret-key-here
```

## Production Deployment Steps

### Option 1: Simple PM2 Deployment
```bash
# Install PM2 globally
npm install -g pm2

# Install dependencies
npm install --production

# Start with PM2
pm2 start src/server.js --name "time-tracker-api"

# Save PM2 configuration
pm2 save
pm2 startup
```

### Option 2: Docker Deployment
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/server.js"]
```

### Option 3: Systemd Service
Create `/etc/systemd/system/time-tracker.service`:
```ini
[Unit]
Description=Time Tracker API
After=network.target

[Service]
Type=simple
User=nodejs
WorkingDirectory=/path/to/app
ExecStart=/usr/bin/node src/server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Security Hardening

1. **Use HTTPS in production**
2. **Set up proper CORS for your domain**
3. **Consider rate limiting adjustments**
4. **Monitor for unusual authentication patterns**
5. **Regular security updates for dependencies**

## Monitoring & Logging

- Application logs go to console
- Consider using Winston or similar for structured logging
- Set up log rotation for production
- Monitor server health via `/health` endpoint

## Scaling Considerations

- In-memory database cannot be scaled horizontally
- Consider load balancer for multiple frontend instances
- Database persistence required for horizontal scaling

## Backup Strategy

**Not applicable for in-memory database** - data is ephemeral.
For production with persistent storage, implement regular database backups.
