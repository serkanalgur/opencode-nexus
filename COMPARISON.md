# OpenCode Nexus — Ekosistem Karşılaştırma Raporu

> **Tarih:** 2026-09-22  
> **Versiyon:** Nexus v1.7.0+  
> **Durum:** Internal Research

---

## Executive Summary

OpenCode ekosisteminde multi-agent orchestration alanında 4 ana plugin bulunmaktadır. Nexus, **tek cost-aware routing** ve **SQLite-backed persistent memory** özellikleriyle rakiplerinden ayrılmaktadır. Ancak oh-my-openagent (OmO) 69k+ star ile dominant konumdadır.

---

## Rakip Plugin'ler

### 1. oh-my-openagent (OmO) — 69.3k ⭐

| Özellik | Durum | Nexus Karşılığı |
|---------|-------|-----------------|
| Multi-agent orchestration | ✅ 11 agent, category-based routing | ✅ 6 role, config-based routing |
| Background agents | ✅ Parallel execution | ✅ `nexus.background()` |
| Team Mode | ✅ Lead + 8 members, tmux viz | ❌ Yok |
| Cost tracking | ❌ Yok | ✅ Real-time + budget |
| Memory | ✅ Supermemory entegrasyonu | ✅ SQLite persistent |
| Security scanning | ✅Built-in | ✅ `nexus.security.scan` |
| LSP integration | ✅ Full LSP support | ❌ Yok |
| AST-Grep | ✅ Pattern-aware code search | ❌ Yok |
| Hash-anchored edits | ✅ LINE#ID validation | ❌ Yok |
| Web dashboard | ❌ Yok | ✅ HTTP + WebSocket |
| Config management | ✅ omo.jsonc | ✅ JSONC + TUI |
| Git worktree | ❌ Yok | ✅ Per-agent isolation |
| Self-healing | ✅ Retry + context transfer | ✅ 4-step escalation |
| Task templates | ❌ Yok | ✅ 4 templates |
| Presets | ❌ Yok | ✅ 4 presets |
| Performance scoring | ❌ Yok | ✅ Model/role scoring |
| Custom agent roles | ❌ Yok | ✅ User-defined roles |
| Execution history | ❌ Yok | ✅ Full tracking |
| Cost forecasting | ❌ Yok | ✅ Pre-execution estimates |

**OmO Avantajları:**
- Çok daha büyük topluluk (69k vs unknown)
- LSP ve AST-Grep entegrasyonu (IDE kalitesinde kod düzenleme)
- Hash-anchored edits (stale-line hatalarını önlüyor)
- Team Mode (gerçek multi-agent parallel execution)
- Claude Code uyumluluğu
- Daha olgun ve test edilmiş

**OmO Dezavantajları:**
- Cost tracking yok (bütçe yönetimi imkansız)
- Web dashboard yok
- Git worktree isolation yok
- Self-healing daha basit (sadece retry)
- Config yönetimi basit (JSONC ama TUI yok)

---

### 2. opencode-workspace — 588 ⭐ (Archived)

| Özellik | Durum | Nexus Karşılığı |
|---------|-------|-----------------|
| Multi-agent | ✅ 4 specialist + 2 orchestrator | ✅ 6 role |
| Background agents | ✅ Async delegation | ✅ `nexus.background()` |
| Planning | ✅ Plan protocol skill | ✅ Task templates |
| Code review | ✅ Dedicated reviewer | ✅ Reviewer role |
| Notifications | ✅ OS notifications | ✅ Cross-platform |
| Git worktree | ✅ Isolation | ✅ Per-agent |
| Cost tracking | ❌ Yok | ✅ Full |
| Memory | ❌ Yok | ✅ SQLite |
| Web dashboard | ❌ Yok | ✅ HTTP + WebSocket |
| Security | ❌ Yok | ✅ Security scan |

**Durum:** V1 only, retired. OpenCode V2'ye port edilmeyecek.

---

### 3. opencode-background-agents — 388 ⭐ (Archived)

| Özellik | Durum | Nexus Karşılığı |
|---------|-------|-----------------|
| Background delegation | ✅ Core feature | ✅ `nexus.background()` |
| Result persistence | ✅ Markdown files | ✅ SQLite + JSONL |
| Context survival | ✅ Compaction-aware | ✅ Memory store |
| Agent orchestration | ❌ Yok | ✅ Full |
| Cost tracking | ❌ Yok | ✅ Full |
| Web dashboard | ❌ Yok | ✅ Full |

**Durum:** V1 only, retired. OpenCode V2 native background subagents kullanıyor.

---

### 4. opencode-conductor — 129 ⭐

| Özellik | Durum | Nexus Karşılığı |
|---------|-------|-----------------|
| Protocol workflow | ✅ Context→Spec→Plan→Implement | ✅ DAG execution |
| Track management | ✅ Features as tracks | ✅ Task templates |
| Smart revert | ✅ Git-aware revert | ❌ Yok |
| Style templates | ✅ 19+ language templates | ❌ Yok |
| Multi-agent | ❌ Single @conductor agent | ✅ 6 roles |
| Cost tracking | ❌ Yok | ✅ Full |
| Memory | ❌ Yok | ✅ SQLite |

---

## Nexus'un Benzersiz Özellikleri

| Özellik | Nexus | Rakipler |
|---------|-------|----------|
| **Cost-Aware Routing** | ✅ Score-based model selection | ❌ Hiçbirinde yok |
| **Real Model Pricing** | ✅ OpenCode API'den canlı fiyat | ❌ Sabit/hardcoded |
| **Web Dashboard** | ✅ HTTP + WebSocket + SPA | ❌ Hiçbirinde yok |
| **SQLite Memory** | ✅ Persistent + TTL + search | ❌ Sadece OmO (Supermemory) |
| **Git Worktree Per Agent** | ✅ Dosya izolasyonu | ❌ Sadece workspace (archived) |
| **Execution History** | ✅ Full tracking + stats | ❌ Hiçbirinde yok |
| **Performance Scoring** | ✅ Model/role effectiveness | ❌ Hiçbirinde yok |
| **Cost Forecasting** | ✅ Pre-execution estimates | ❌ Hiçbirinde yok |
| **Custom Agent Roles** | ✅ User-defined via config | ❌ Hiçbirinde yok |
| **JSONC Config + TUI** | ✅ Interactive configuration | ❌ Sadece OmO (JSONC) |
| **Self-Healing 4-Step** | ✅ Retry→Respawn→Fallback→Alert | ⚠️ OmO: sadece retry |
| **Task Templates** | ✅ 4 built-in templates | ❌ Hiçbirinde yok |
| **Preset Configs** | ✅ 4 presets | ❌ Hiçbirinde yok |
| **Security Scanning** | ✅ Built-in scanner | ⚠️ OmO: var |
| **Fan-Out Routing** | ✅ Topic-based pub/sub | ❌ Hiçbirinde yok |

---

## Nexus'un Eksik Özellikleri (Rakiplerde Olan)

| Özellik | OmO | workspace | conductor | Nexus |
|---------|-----|-----------|-----------|-------|
| LSP Integration | ✅ | ❌ | ❌ | ✅ Plugin ile |
| AST-Grep | ✅ | ❌ | ❌ | ❌ |
| Hash-Anchored Edits | ✅ | ❌ | ❌ | ❌ |
| Team Mode | ✅ | ❌ | ❌ | ❌ |
| Tmux Integration | ✅ | ❌ | ❌ | ❌ |
| Smart Revert | ❌ | ❌ | ✅ | ❌ |
| Style Templates | ❌ | ❌ | ✅ | ❌ |
| Supermemory | ✅ | ❌ | ❌ | ❌ |
| Websearch MCP | ✅ | ✅ | ❌ | ❌ |
| Context7 MCP | ✅ | ✅ | ❌ | ❌ |
| Goal/Continuation | ✅ | ❌ | ❌ | ❌ |
| Todo Enforcer | ✅ | ❌ | ❌ | ❌ |

---

## Pazar Konumu

```
                    Cost-Aware
                         ↑
                         │
         Nexus ●─────────┼─────────○ OmO
         (12 tools)      │         (11 agents, 54+ hooks)
                         │
    ─────────────────────┼────────────────────→ Feature Richness
                         │
      Conductor ○────────┼─────────○ workspace
      (Protocol)         │         (Archived)
                         │
                    Basic Orchestration
```

**Nexus'un Pozisyonu:** Cost-aware, persistent memory, ve web dashboard ile segmentte benzersiz. Ama feature richness açısından OmO'nun gerisinde.

---

## Öneri: Nexus'un Geliştirme Öncelikleri

### Kısa Vadeli (1-2 hafta)
1. **LSP Integration** — ✅ Plugin olarak otomatik etkinleştiriliyor
2. **Todo Enforcer** — Agent'ların takipte kalmasını sağlar
3. **Goal/Continuation** — Uzun vadeli görevler için devamlılık

### Orta Vadeli (1-2 ay)
4. **Team Mode** — Gerçek parallel multi-agent (OmO'nun en güçlü özelliği)
5. **AST-Grep** — Pattern-aware code search
6. **Web Dashboard Polish** — DAG visualization, log stream, config editor

### Uzun Vadeli (3+ ay)
7. **Claude Code Uyumluluğu** — Mevcut hook/command'ları çalıştırma
8. **Skill-Embedded MCPs** — Context-aware MCP sunucuları
9. **Hash-Anchored Edits** — Stale-line hatalarını önleme

---

## Sonuç

Nexus, **cost-aware orchestration**, **persistent memory**, ve **web dashboard** alanlarında rakipsizdir. OmO ile rekabet edebilmek için:

1. ~~**LSP**~~ ✅ Done — Plugin olarak otomatik etkinleştiriliyor
2. **AST-Grep** eklenmeli (pattern-aware code search)
3. **Team Mode** eklenmeli (parallel multi-agent)

Bu 2 özellik eklenirse, NexusOmO ile doğrudan rekabet edebilecek konuma gelir.
