## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- No local Python or Node needed

---

## Running the App

### 1. Clone the repo

```bash
git clone https://github.com/RakhelFadhilaN/filter-design-tool.git
cd filter-design-tool
```

### 2. Start everything

```bash
docker compose up -d
```

First run will take a minute while it builds the images and pulls dependencies.

### 3. Open the app

- **Frontend:** http://localhost:3000
- **Backend API docs:** http://localhost:8000/docs

---

## Rebuilding After Code Changes

If you edit any source files (e.g. `main.py`, `page.tsx`), you need to rebuild the Docker images — just restarting the containers won't pick up the changes.

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

---
