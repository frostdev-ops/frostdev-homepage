import { bootStatus } from './status.ts';
import { bootWards } from './wards.ts';
import { bootPages } from './pages.ts';
import './mail.ts';
import './charts.ts';
import './logic.ts';
import './notion.ts';
import './agent.ts';
import './browser.ts';
import './note.ts';
import './store.ts';
import './mcp.ts';
import './chat.ts';
import { bootEdit } from './edit.ts';
import { bootLogicEdit } from './logic-edit.ts';

// The entrance cascade is pure CSS (.wd-enter in frost.css, staggered via an
// inline animation-delay per shell). Never animate cards with WAAPI here: a
// lingering fill phase overrides every inline style.transform write and
// silently kills the drag engine's follow/FLIP/spring rendering.

bootStatus();
bootPages(); // stages the current page before any ward boots
bootWards();
bootEdit();
bootLogicEdit();
