# blixten85/product-describer-cloudflare Wiki

> This directory is machine-managed by cubic. Edit wiki content through [cubic wiki settings](https://www.cubic.dev/wiki/blixten85/product-describer-cloudflare) and custom instructions.

Wiki version: 1
Source commit: 32cf25690b23d01cb0892c40f5f1c23bd4c4e4d3
Source branch: main
Generated: 2026-07-19T20:22:31.937Z

## Contents

### Overview

- [Home & Introduction](01-overview/01-home-introduction.md)
- [Local Setup & Development](01-overview/02-local-setup.md)
- [Migration from Flask & Docker](01-overview/03-migration-flask-docker.md)
- [GitHub Workflows & Standards](01-overview/04-github-workflows-standards.md)

### System Architecture

- [Architecture Overview](02-system-architecture/01-architecture-overview.md)
- [Playwright Fetcher & Pull Model](02-system-architecture/02-playwright-fetcher.md)
- [Security, Auth & Roles](02-system-architecture/03-security-auth-roles.md)

### Core Features

- [Document Extraction Engine](03-core-features/01-document-extraction.md)
- [Row-by-Row AI Generation](03-core-features/02-row-by-row-ai-generation.md)
- [Public Catalog & Browsing](03-core-features/03-public-catalog.md)
- [Price Monitoring & Watchers](03-core-features/04-price-monitoring.md)
- [Page Suggestions & Approvals](03-core-features/05-page-suggestions.md)
- [Ansökningsunderlag (Social Services)](03-core-features/06-ansokningsunderlag.md)
- [Automatic Error Reporting](03-core-features/07-automatic-error-reporting.md)

### Data Management & Flow

- [D1 Database Schema & Models](04-data-management-flow/01-d1-database-schema.md)
- [R2 Storage Integration](04-data-management-flow/02-r2-storage-integration.md)
- [D1 Lease & Acknowledgment Pattern](04-data-management-flow/03-d1-lease-ack-pattern.md)
- [Engine Cron Scheduler Workflow](04-data-management-flow/04-engine-cron-scheduler.md)

### Frontend Components

- [Main UI & App Routing](05-frontend-components/01-main-ui-routing.md)
- [Admin Dashboard UI](05-frontend-components/02-admin-dashboard.md)

### Backend Systems

- [App Worker API](06-backend-systems/01-app-worker-api.md)
- [Processor Worker (Queue Consumer)](06-backend-systems/02-processor-worker.md)
- [Engine Worker (Catalog Engine)](06-backend-systems/03-engine-worker.md)
- [Token Rotator Worker](06-backend-systems/04-token-rotator-worker.md)

### Model Integration

- [Supported AI Providers](07-model-integration/01-ai-providers.md)
- [LLM Prompts & Instructions](07-model-integration/02-prompts-instructions.md)
- [Encrypted Provider Configurations](07-model-integration/03-encrypted-provider-configs.md)

### Deployment & Infrastructure

- [Deployment & Secrets Management](08-deployment-infrastructure/01-deployment-configuration.md)

### Extensibility and Customization

- [Extending Alert Channels](09-extensibility-customization/01-adding-alert-channels.md)
- [Adding New AI Providers](09-extensibility-customization/02-adding-ai-providers.md)
