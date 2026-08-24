# Employee Time Tracking Application

A full-stack web application for tracking and reporting employee hourly work across different clients.

## ⚠️ Important Notes

### Data Persistence
**This application uses SQLite in-memory database as specified in requirements.**
- ⚠️ **All data is lost when the backend server restarts**
- Suitable for development and testing
- For production use, modify `backend/src/database/init.js` to use file-based SQLite instead of `:memory:`

### Authentication
- Email-only authentication with JWT tokens
- No password required - assumes trusted internal network
- Anyone with a valid email can create an account and log in
- Consider integrating with company SSO for production use

## Features

- ✅ User authentication (email-based with JWT tokens)
- ✅ Add, edit, and delete clients
- ✅ Add, edit, and delete hourly work entries for each client
- ✅ View hourly reports for each client
- ✅ Export hourly reports to CSV or PDF

## Tech Stack

### Frontend
- **React** with TypeScript
- **Vite** for build tooling
- **Material UI** for components
- **React Query** for server state management
- **React Router** for navigation
- **Axios** for API calls

### Backend
- **Node.js** with Express
- **SQLite** in-memory database
- **JWT** for authentication
- **Joi** for validation
- **PDFKit** for PDF generation
- **csv-writer** for CSV export

## Project Structure

```
.
├── backend/
│   ├── src/
│   │   ├── database/
│   │   │   └── init.js           # Database initialization
│   │   ├── middleware/
│   │   │   ├── auth.js           # JWT authentication
│   │   │   └── errorHandler.js  # Error handling
│   │   ├── routes/
│   │   │   ├── auth.js           # Authentication endpoints
│   │   │   ├── clients.js        # Client CRUD
│   │   │   ├── workEntries.js    # Work entry CRUD
│   │   │   └── reports.js        # Reporting & export
│   │   ├── validation/
│   │   │   └── schemas.js        # Joi validation schemas
│   │   └── server.js             # Express server
│   ├── package.json
│   └── DEPLOYMENT.md             # Production deployment guide
│
└── frontend/
    ├── src/
    │   ├── api/
    │   │   └── client.ts         # API client with JWT
    │   ├── components/
    │   │   └── Layout.tsx        # Main layout
    │   ├── contexts/
    │   │   └── AuthContext.tsx   # Auth state management
    │   ├── pages/
    │   │   ├── LoginPage.tsx     # Login page
    │   │   ├── DashboardPage.tsx # Dashboard
    │   │   ├── ClientsPage.tsx   # Client management
    │   │   ├── WorkEntriesPage.tsx # Work entry management
    │   │   └── ReportsPage.tsx   # Reports & exports
    │   ├── types/
    │   │   └── api.ts            # TypeScript interfaces
    │   └── App.tsx               # Main app component
    └── package.json
```

## Getting Started

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager

### Backend Setup

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create environment file:
```bash
cp .env.example .env
```

4. Update `.env` with your configuration:
```bash
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
JWT_SECRET=your-secure-secret-key-change-this
```

5. Start the development server:
```bash
npm run dev
```

Backend will be running at `http://localhost:3001`

### Frontend Setup

1. Navigate to frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Create environment file:
```bash
cp .env.example .env
```

4. Update `.env`:
```bash
VITE_API_URL=http://localhost:3001
```

5. Start the development server:
```bash
npm run dev
```

Frontend will be running at `http://localhost:5173`

## Usage

1. Open `http://localhost:5173` in your browser
2. Enter any email address to log in (no password required)
3. Start adding clients and tracking work hours
4. View reports and export data as CSV or PDF

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email, returns JWT token
- `GET /api/auth/me` - Get current user info (requires auth)

### Clients
- `GET /api/clients` - Get all clients
- `POST /api/clients` - Create new client
- `GET /api/clients/:id` - Get specific client
- `PUT /api/clients/:id` - Update client
- `DELETE /api/clients/:id` - Delete client

### Work Entries
- `GET /api/work-entries` - Get all work entries (optional ?clientId filter)
- `POST /api/work-entries` - Create new work entry
- `GET /api/work-entries/:id` - Get specific work entry
- `PUT /api/work-entries/:id` - Update work entry
- `DELETE /api/work-entries/:id` - Delete work entry

### Reports
- `GET /api/reports/client/:clientId` - Get hourly report for client
- `GET /api/reports/export/csv/:clientId` - Export report as CSV
- `GET /api/reports/export/pdf/:clientId` - Export report as PDF

All authenticated endpoints require `Authorization: Bearer <token>` header.

## Security Features

- JWT-based authentication with 24-hour token expiration
- Rate limiting on authentication endpoints (5 attempts per 15 minutes)
- CORS protection
- Helmet security headers
- Input validation with Joi schemas
- SQL injection protection with parameterized queries

## Development

### Backend Development
```bash
cd backend
npm run dev  # Starts with nodemon for auto-reload
```

### Frontend Development
```bash
cd frontend
npm run dev  # Starts Vite dev server with HMR
```

### Running Tests

**Backend:**
```bash
cd backend
npm test                    # Run all tests
npm run test:coverage       # Run tests with coverage report
npm run test:watch          # Run tests in watch mode
```

### Test Coverage

The backend has comprehensive test coverage with **161 tests** across 8 test suites:

| File | Statements | Branches | Functions | Lines |
|------|------------|----------|-----------|-------|
| **Overall** | **90.16%** | **93.82%** | **92.18%** | **90.35%** |
| database/init.js | 100% | 100% | 100% | 100% |
| middleware/auth.js | 100% | 100% | 100% | 100% |
| middleware/errorHandler.js | 100% | 100% | 100% | 100% |
| routes/auth.js | 100% | 100% | 100% | 100% |
| routes/clients.js | 97.89% | 100% | 100% | 97.89% |
| routes/workEntries.js | 98.41% | 100% | 100% | 98.41% |
| routes/reports.js | 64.15% | 69.44% | 68.75% | 64.42% |
| validation/schemas.js | 100% | 100% | 100% | 100% |

Coverage thresholds are configured in `jest.config.js`:
- Statements: 60%
- Branches: 60%
- Functions: 65%
- Lines: 60%

### Building for Production

**Backend:**
```bash
cd backend
npm start  # Production mode
```

**Frontend:**
```bash
cd frontend
npm run build  # Creates optimized production build in dist/
npm run preview  # Preview production build
```

## Production Deployment

See `backend/DEPLOYMENT.md` for detailed production deployment instructions.

### Quick Production Checklist
- [ ] Set strong `JWT_SECRET` in environment variables
- [ ] Configure proper `FRONTEND_URL` for CORS
- [ ] Consider switching to file-based SQLite for data persistence
- [ ] Set up HTTPS/SSL certificates
- [ ] Configure proper logging and monitoring
- [ ] Set up automated backups (if using persistent storage)
- [ ] Review and adjust rate limiting settings
- [ ] Consider integrating with company SSO

## Known Limitations

1. **In-memory database** - All data is lost on server restart
2. **Email-only auth** - No password protection, assumes trusted network
3. **No user roles** - All users have equal access to all data
4. **Single-server architecture** - Not designed for horizontal scaling
5. **No real-time updates** - Changes require page refresh

## Future Enhancements

- Persistent database storage
- User roles and permissions
- Multi-tenancy support
- Real-time updates with WebSockets
- Advanced reporting and analytics
- Email notifications
- Mobile app
- Integration with calendar systems

## PRQE run configuration

`devin/config.yaml` describes this repository to the shared PRQE quality playbooks — PR analysis,
heartbeat, functional, performance and final analysis. Those playbooks run across repositories and
name nothing repo-specific, so everything they need to know about this layout is declared there:
the heartbeat command, how a diff maps to Jest suites, which paths force the full suite, and the
report type each stage publishes. `devin/tools/` holds the scripts the stages call and
`devin/README.md` explains the folder; see that file before changing anything in it.

```bash
python3 devin/tools/heartbeat.py --backend-url http://localhost:3001 --frontend-url http://localhost:5173 \
  --run-id local --appname timesheet-app --out-dir reports/local
```

**The heartbeat must never send `x-user-email`.** The auth middleware creates the user when that
header names one that does not exist, so a liveness probe using it would write application data
before the suites run. The declared checks probe the protected routes anonymously (expecting `401`)
and post an invalid email to `/api/auth/login` (expecting Joi's `400`), which exercises the auth
surface without an INSERT.

Performance remains unavailable: it needs a k6 critical-journey script that does not exist here.

Note that the Jest suites run in-process against in-memory SQLite, so they exercise the code but
not the deployed environment; the heartbeat is the only stage that proves a deployment works.

Keep the config current when paths move — a wrong path makes a stage skip or fall back to the
full suite, which is the silent failure the selection logic exists to avoid.

## License

MIT

## Support

For issues or questions, please contact your system administrator.
