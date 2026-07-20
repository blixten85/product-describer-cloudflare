# blixten85/product-describer-cloudflare Wiki

> This directory is machine-managed by cubic. Edit wiki content through [cubic wiki settings](https://www.cubic.dev/wiki/blixten85/product-describer-cloudflare) and custom instructions.

Wiki version: 2
Source commit: db0cf84a50466bfd40b087ceebdfac4a9bb7181f
Source branch: main
Generated: 2026-07-20T06:43:18.719Z

## Contents

### Overview

- [Home & Introduction](01-s-overview/01-page-overview-home.md)
- [Local Setup & Development](01-s-overview/02-page-overview-setup.md)
- [Migration from Flask & Docker](01-s-overview/03-page-overview-migration.md)
- [GitHub Workflows & Standards](01-s-overview/04-page-overview-workflows.md)

### System Architecture

- [Architecture Overview](02-s-architecture/01-page-arch-overview.md)
- [Playwright Fetcher & Pull Model](02-s-architecture/02-page-arch-fetcher.md)
- [Security, Authentication, & Roles](02-s-architecture/03-page-arch-security.md)

### Core Features

- [Document Extraction Engine](03-s-features/01-page-feat-extraction.md)
- [Row-by-Row AI Generation](03-s-features/02-page-feat-ai-gen.md)
- [Public Catalog & Browsing](03-s-features/03-page-feat-catalog.md)
- [Price Monitoring & Alerts](03-s-features/04-page-feat-price.md)
- [Page Suggestions & Approvals](03-s-features/05-page-feat-suggestions.md)
- [Ansökningsunderlag / Bistånd](03-s-features/06-page-feat-bistand.md)
- [Automatic Error Reporting](03-s-features/07-page-feat-error-reporting.md)

### Data Management & Flow

- [D1 Database Schema & Models](04-s-data/01-page-data-d1.md)
- [Job Lease & Acknowledgment Pattern](04-s-data/02-page-data-lease.md)
- [R2 File Storage Integration](04-s-data/03-page-data-r2.md)
- [Engine Cron Scheduler Workflow](04-s-data/04-page-data-cron.md)

### Frontend Components

- [Main UI & Routing](05-s-frontend/01-page-ui-main.md)
- [Admin Dashboard UI](05-s-frontend/02-page-ui-admin.md)
- [CSS & Styling Architecture](05-s-frontend/03-page-ui-css.md)

### Backend Systems

- [App Worker API](06-s-backend/01-page-backend-app.md)
- [Processor Worker (Queue Consumer)](06-s-backend/02-page-backend-processor.md)
- [Engine Worker (Catalog Engine)](06-s-backend/03-page-backend-engine.md)
- [Token Rotator Worker](06-s-backend/04-page-backend-rotator.md)

### Model Integration

- [Supported AI Providers](07-s-model/01-page-model-providers.md)
- [LLM Prompts & Instructions](07-s-model/02-page-model-prompts.md)
- [Encrypted Provider Configurations](07-s-model/03-page-model-configs.md)

### Deployment & Infrastructure

- [Deployment & Secrets Management](08-s-deploy/01-page-deploy-secrets.md)

### Extensibility and Customization

- [Adding New AI Providers](09-s-extensibility/01-page-extend-ai.md)
- [Extending Alert Channels](09-s-extensibility/02-page-extend-alerts.md)
