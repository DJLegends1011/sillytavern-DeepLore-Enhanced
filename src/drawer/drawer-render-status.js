import { chat_metadata } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex,
    indexing, indexEverLoaded, computeOverallStatus,
    vaultAvgTokens, claudeAutoEffortBad, claudeAutoEffortDetail,
    pipelinePhase,
    suppressNextAgenticLoop,
} from '../state.js';
import { getCurrent as getCurrentVerdict } from '../verdict/verdict-store.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import { ds, MODE_LABELS, MODE_DESCRIPTIONS, STATUS_CLASSES, STATUS_DESCRIPTIONS, announceToScreenReader, formatTokensCompact } from './drawer-state.js';

let _lastAnnouncedStatus = null;
let _lastStatusKey = null;
let _lastSkipToolsState = null;

// Cleaned Illustrator exports: XML/style blocks stripped, fills → currentColor.
const STATUS_SVG_IDLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 375" fill="currentColor"><path fill-rule="evenodd" d="M228.93,357.53c-18.46,0-36.93.01-55.39,0-6.97-.01-8.36-1.48-9.99-8.39-2.72-11.52-5.63-23-8.76-34.42-2.56-9.33-9.19-14.32-18.63-14.47-9.81-.16-19.64.7-29.46,1.07-5.48.21-10.97.69-16.43.39-10.65-.57-17.71-6.08-19.97-16.53-1.95-8.99-2.53-18.27-3.88-27.4-.69-4.68-1.54-9.37-2.69-13.95-1.9-7.57-6.22-13.53-12.7-17.91-2.38-1.61-4.81-3.16-7.01-4.99-5.17-4.31-5.96-10.54-2.05-15.99 1.6-2.22 3.34-4.4 5.3-6.3 16.1-15.59 21.18-34.5 18.11-56.44-2.72-19.49-1-38.65 7.38-56.82 11.32-24.54 29.97-41.76 53.8-53.62 28.48-14.17 58.65-17.71 89.94-13.77 21.29 2.68 41.42 8.79 59.64 20.37 29.01 18.43 45.39 45.46 53.11 78.47 9.34 39.95.48 76.21-21.62 109.87-4.59 6.99-9.5 13.76-14.39 20.54-9.35 12.96-12.51 27.64-11.48 43.25 1.26 19.02 5.93 37.44 10.96 55.75 2.14 7.78-.46 11.27-8.4 11.28-18.46.02-36.93 0-55.39 0z M188,233.59c-16.46-1.72-30.63-7.05-43.31-16.24-29.56-21.43-42.78-57.87-33.99-93.49 8.51-34.48 37.98-60.73 73.77-65.7 26.63-3.7 47.26 9.82 52.96 34.69 3.84 16.77-2.95 32.93-18.08 43.06-8 5.36-17.03 8.15-26.18 10.68-11.24 3.11-21.53 8.02-29.43 16.92-15.47 17.44-12.46 44.92 6.63 60.72 2.48 2.05 5.24 3.84 8.08 5.37 2.71 1.46 5.7 2.42 9.55 3.99z M197.15,203.71c-6.05-.16-10.86-5.23-10.64-11.21.22-5.99 5.38-10.87 11.27-10.68 5.96.2 10.89 5.44 10.64 11.3-.26 6.13-5.18 6.75-11.27 10.59z"/><path d="M197.59,90.51c5.96.08 10.95 5.17 10.86 11.09-.08 5.92-5.21 10.95-11.09 10.88-5.95-.07-10.91-5.16-10.84-11.1.07-6 5.12-10.95 11.07-10.87z"/></svg>`;

const STATUS_SVG_CHOOSING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 375" fill="currentColor"><path d="M229.88,358c-18.33,0-36.67.01-55,0-7.02,0-8.42-1.47-10.04-8.33-2.75-11.64-5.66-23.25-8.87-34.77-2.55-9.17-9.2-14.01-18.47-14.17-9.81-.16-19.63.69-29.45,1.05-5.47.2-10.97.69-16.42.4-10.65-.56-17.75-6.07-20.01-16.47-1.95-8.99-2.54-18.27-3.89-27.4-.69-4.68-1.53-9.37-2.68-13.95-1.89-7.56-6.18-13.55-12.67-17.93-2.27-1.53-4.59-3.02-6.73-4.74-5.53-4.45-6.38-10.81-2.18-16.52 1.7-2.31 3.53-4.56 5.57-6.56 15.73-15.37 20.65-34 17.69-55.48-2.41-17.52-1.49-34.92 5.02-51.66 10.59-27.22 30.09-46.14 55.71-59.01 28.52-14.33 58.83-17.92 90.25-13.96 21.28 2.68 41.42 8.77 59.63 20.35 29.12 18.51 45.51 45.63 53.2 78.79 9.24 39.83.35 75.95-21.64 109.49-4.51 6.88-9.34 13.57-14.18 20.23-9.55 13.15-12.78 28.02-11.69 43.92 1.3 18.89 5.92 37.18 10.91 55.37 2.18 7.93-.43 11.33-8.7 11.34-18.46.01-36.92-.01-55.37 0z M198.59,74.11c-41.23.3-73.53 33.2-73.2 74.56.32 39.95 33.97 72.84 74.03 72.37 40.29-.47 72.93-33.62 72.66-73.76-.28-40.68-33.22-73.47-73.49-73.17z"/><path d="M112.61,103.07c-.65-.89-1.27-2.64-2.34-2.98-1.27-.4-3.03.19-4.36.82-.72.34-1.03 1.64-1.43 2.54-4.93 11.18-7.84 22.87-8.62 35.07-1.41 22.1 3.73 42.59 15.17 61.52 1.26 2.08 2.95 3.25 5.26 1.98 2.47-1.35 2.47-3.51 1.17-5.78-.31-.54-.64-1.07-.94-1.62-15.91-28.26-17.82-57.4-5.48-87.44.47-1.14.89-2.32 1.57-4.11z"/><path d="M301.8,149.24c-.68-6.2-1.04-12.46-2.15-18.57-1-5.5-2.81-10.85-4.29-16.26-.72-2.62-1.94-4.96-5.17-3.9-3.21 1.05-2.79 3.58-1.92 6.19 10.53 31.64 6.47 61.26-12.34 88.8-1.48 2.16-2.48 4.35.11 6.18 2.71 1.92 4.53.3 6.14-2.01 12.68-18.12 19.07-38.24 19.62-60.43z"/><path d="M112.41,95.6c1.39 4.22 2.44 8.34 4.18 12.14.62 1.35 3 2.79 4.44 2.66 2.43-.21 3.3-2.4 2.53-4.84-1.35-4.28-2.65-8.58-4.2-12.78-1.47-4-4.84-5.6-9-4.38-4.06 1.18-8.07 2.54-12.08 3.86-2.4.79-4.06 2.25-3.07 4.99.96 2.67 3.08 2.9 5.53 2.08 3.76-1.24 7.55-2.42 11.67-3.73z"/><path d="M273,215.51c-.55-4.42-1.08-8.48-1.56-12.55-.29-2.52-1.62-3.99-4.17-3.71-2.6.28-3.51 2.16-3.25 4.59.45 4.35.87 8.7 1.52 13.02.63 4.17 3.73 6.54 7.97 6.21 4.1-.33 8.18-.83 12.27-1.31 2.6-.3 4.74-1.25 4.31-4.42-.4-2.96-2.57-3.29-5.04-3.03-3.93.42-7.86.79-12.05 1.2z"/><path d="M263.21,69.9c-1.09.93-2.74 1.68-3.01 2.76-.32 1.3.09 3.27.96 4.28 2.42 2.81 5.23 5.28 7.89 7.88 1.8 1.76 3.71 2 5.54.14 1.72-1.74 1.47-3.62-.15-5.27-2.7-2.74-5.45-5.43-8.25-8.06-.66-.63-1.63-.97-2.98-1.73z"/><path d="M194.53,248.9c2.56.06 4.62-.77 4.82-3.58.2-2.82-1.65-3.85-4.29-4.01-3.36-.2-6.71-.57-10.05-.95-2.58-.3-4.59.36-4.97 3.18-.35 2.62 1.25 3.89 3.71 4.17 3.59.42 7.18.8 10.78 1.19z"/><path d="M134.56,218.66c-.27-1-.25-1.61-.54-1.92-3.27-3.54-6.46-7.18-10.01-10.42-.66-.61-3.32-.06-4.13.82-.8.87-1.11 3.37-.45 4.2 2.78 3.47 5.89 6.69 9.14 9.74.73.69 2.66.72 3.7.27 1.03-.46 1.65-1.9 2.29-2.69z"/><path d="M153.64,231.8c-.26-.45-.54-1.59-1.26-2.09-3.68-2.54-7.35-5.13-11.29-7.19-.97-.51-3.63.46-4.25 1.51-.62 1.04-.22 3.74.7 4.48 3.4 2.68 7.1 5.02 10.88 7.12 2.44 1.35 5.27-.67 5.22-3.83z"/><path d="M257.67,66.28c-.25-.45-.51-1.62-1.22-2.07-3.87-2.45-7.75-4.93-11.88-6.89-.95-.45-3.57.77-4.12 1.87-.54 1.08.08 3.68 1.07 4.41 3.39 2.47 7.1 4.55 10.83 6.51 2.42 1.26 5.25-.69 5.32-3.83z"/><path d="M280.25,88.1c-3.71-.08-5.41 3.03-3.79 5.86 1.85 3.23 3.91 6.33 5.86 9.5 1.29 2.09 2.98 3.04 5.28 1.67 2.28-1.36 2.34-3.38 1.11-5.46-1.89-3.2-3.82-6.39-5.92-9.46-.69-1.04-2-1.66-2.54-2.11z"/><path d="M233.07,59.93c.9-.83 2.72-1.74 2.88-2.88.19-1.37-.68-3.83-1.73-4.25-4.11-1.67-8.42-2.96-12.76-3.83-1.09-.22-3.22 1.41-3.72 2.66-.4.99.63 3.53 1.61 3.92 4.24 1.68 8.69 2.83 13.72 4.38z"/><path d="M172.08,245.67c1.1-1.02 2.99-1.96 3.23-3.22.24-1.29-.76-3.69-1.87-4.2-3.82-1.75-7.87-3.13-11.96-4.1-1.16-.27-3.49 1.07-3.95 2.21-.45 1.11.39 3.79 1.38 4.26 4.02 1.93 8.32 3.26 13.17 5.05z"/><path d="M243.85,142.57c6.33-2.3 10.04-1.72 12.83 1.87 2.41 3.09 2.45 7.68.09 10.78-2.87 3.78-6.4 4.29-13.69 1.7 0 3.39.12 6.59-.03 9.79-.27 5.64-2.68 7.81-8.28 7.73-2.35-.03-4.7-.01-7.07-.01 2.17 7.02 1.47 10.79-2.46 13.38-3.17 2.08-7.57 1.79-10.45-.69-3.43-2.95-3.81-6.7-.98-13.34-2.81 0-5.36.13-7.89-.03-5.12-.32-7.35-2.78-7.38-7.93-.02-3.22 0-6.44 0-10.28 5.55 2.88 10.24 3.27 13.93-1.55 2.44-3.19 2.19-7.66-.35-10.75-2.86-3.48-6.59-3.99-12.73-1.65 0-3.1-.24-6.16.06-9.18.39-3.98 3.01-6.26 7.1-6.2 10.24.14 20.47.39 30.7.75 4.06.14 6.44 2.89 6.57 7.16.08 2.75.01 5.48.01 8.45z"/><path d="M155.11,124.92c-2.3-6.33-1.72-10.04 1.87-12.83 3.09-2.41 7.68-2.45 10.78-.09 3.78 2.87 4.29 6.4 1.7 13.69 3.39 0 6.59-.12 9.79.03 5.64.27 7.81 2.68 7.73 8.28-.03 2.35-.01 4.7-.01 7.07 7.02-2.17 10.79-1.47 13.38 2.46 2.08 3.17 1.79 7.57-.69 10.45-2.95 3.43-6.7 3.81-13.34.98 0 2.81.13 5.36-.03 7.89-.32 5.12-2.78 7.35-7.93 7.38-3.22.02-6.44 0-10.28 0 2.88-5.55 3.27-10.24-1.55-13.93-3.19-2.44-7.66-2.19-10.75.35-3.48 2.86-3.99 6.59-1.65 12.73-3.1 0-6.16.24-9.18-.06-3.98-.39-6.26-3.01-6.2-7.1.14-10.24.39-20.47.75-30.7.14-4.06 2.89-6.44 7.16-6.57 2.75-.08 5.48-.01 8.45-.01z"/></svg>`;

const STATUS_SVG_WRITING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 375" fill="currentColor"><path d="M194.42,152.75c-4.93-2.14-9.18-3.54-12.98-5.71-22.91-13.09-26.92-45.21-8.09-63.68 16.61-16.3 45.85-10.28 52.88 10.88 4.88 14.69-3.58 30.75-17.85 33.87-15.07 3.3-28.86-9.82-25.12-24.05 1.66-6.32 5.55-10.85 12.13-12.51 5.85-1.48 10.89.18 15.01 4.44 4.62 4.78 4.75 12.54.49 17.45-1.44 1.67-3.1 2.73-5.18 1.26-2.14-1.52-2.05-3.39-.61-5.52 2.38-3.53 2.19-6.37-.3-8.73-2.82-2.67-7.5-2.93-10.69-.6-5.36 3.92-5.8 12.31-.9 17.19 5.69 5.68 15.05 5.8 21.01.29 8.48-7.85 8.35-21.4-.27-29.35-11.45-10.56-28.95-8.81-38.56 3.85-8.23 10.84-9.11 25.67-2.21 37.36 7 11.87 20.76 18.47 34.48 16.05 4.48-.79 8.81-2.55 13.1-4.16 2.21-.83 4.23-1.41 5.56.93 1.41 2.48.21 4.38-2.2 5.42-3.97 1.7-8 3.25-13.15 5.32 2.36 0 3.72 0 5.08 0 30.95 0 61.9-.01 92.85.01 7.4 0 9.56 2.27 10.64 9.56 4.86 32.67-4.47 61.77-22.06 88.79-3.95 6.07-8.18 11.95-12.48 17.78-9.05 12.28-11.99 26.2-10.86 41.08 1.26 16.63 5.22 32.76 9.67 48.78.23.84.47 1.68.68 2.53 1.25 5.16-1.32 8.77-6.59 8.77-34.82.05-69.64.05-104.45.01-4.07 0-5.91-1.75-6.89-5.95-2.19-9.35-4.02-18.81-6.64-28.04-4.27-15.04-9.42-18.87-24.98-18.61-8.71.15-17.41 1.28-26.12 1.8-3.34.2-6.75.24-10.06-.17-10.55-1.28-16.21-6.28-18.13-16.87-1.66-9.2-2.55-18.55-3.71-27.83-1.45-11.58-6.34-20.93-16.86-26.77-1.08-.6-2.08-1.4-3.01-2.21-4.67-4.08-5.42-9.75-1.64-14.68 2.88-3.76 6.14-7.24 9.23-10.84 9.12-10.61 13.8-22.69 12.51-36.88-.59-6.47-.83-12.97-1.22-19.46-.49-8.17 2.03-10.81 10.35-10.81 34.32-.01 68.64 0 102.96 0 1.45 0 2.9 0 5.19 0z"/><path d="M312.14,114.57c-.17 19.86-18.3 33.1-35.43 25.79-13.42-5.72-17.65-21.86-8.53-32.59 4.79-5.64 12.95-7.54 19.75-4.59 6.29 2.73 9.73 8.51 9.09 15.28-.9 9.42-11.08 14.88-18.77 10.09-2.04-1.27-3.29-2.91-1.99-5.26 1.17-2.11 3.11-2.34 5.15-1.16 2.98 1.72 5.51 1.31 7.45-1.58 2.04-3.03 1.37-7.1-1.56-9.41-2.84-2.23-6.04-2.88-9.49-1.58-4.14 1.56-6.34 4.76-7.03 8.96-1.72 10.41 8.38 18.83 19.39 16.23 10.78-2.55 17.2-14.68 13.97-26.4-2.45-8.89-9.87-15.69-18.74-16.65-10.16-1.09-18.74 1.84-24.55 10.84-.4.63-.77 1.29-1.09 1.96-1.1 2.31-2.87 3.22-5.17 2-2.18-1.16-2.18-3.07-1.18-5.16 3.08-6.47 7.87-11.21 14.38-14.11 19.35-8.6 40.01 1.83 43.85 22.11.52 2.34.54 4.11.7 5.74z"/><path d="M79.78,117.28c.01-14 9.38-26.01 22.82-29.26 14.22-3.44 29.19 3.06 35.37 15.32 1.16 2.3 2 4.62-.9 6.09-2.56 1.29-4.08-.27-5.34-2.5-6.3-11.17-19.7-15.72-31.21-10.69-13.52 5.91-17.99 23.3-8.99 35 5.74 7.46 16.49 9.03 24.09 3.54 5.79-4.18 7.41-12.08 3.69-18-3.26-5.19-10-6.55-14.63-2.94-2.94 2.28-3.81 6.31-1.87 9.38 1.94 3.08 4.54 3.56 7.7 1.75 2.07-1.19 3.99-.77 5.07 1.38 1.09 2.16.07 3.79-1.87 5.02-3.99 2.53-9.8 2.28-13.73-.67-4.39-3.29-6.44-9.67-4.71-15.14 1.92-6.08 6.28-9.46 12.4-10.57 6.75-1.22 12.39 1 16.51 6.39 4.77 6.24 5.71 13.27 2.57 20.5-3.37 7.76-9.71 11.99-17.91 13.01-16.11 2.01-29.02-10.4-29.01-27.61z"/><path d="M169.57,25.37c0-12.54 9.64-22.45 22.67-23.31 12.14-.81 22.93 7.88 24.33 19.59.89 7.45-3.41 15.65-10.03 19.13-6.32 3.32-13.86 2.33-19.13-2.49-4.85-4.44-6.13-11.39-3.17-17.12 2.73-5.27 8.05-7.91 13.71-6.78 8.07 1.6 11.71 10.98 6.65 17.12-1.49 1.81-3.3 2.96-5.48 1.4-2.14-1.53-1.72-3.38-.5-5.57.67-1.2.75-3.95.02-4.46-1.38-.96-3.8-1.54-5.3-.98-4.06 1.51-4.71 7.39-1.43 10.73 2.8 2.85 6.26 3.66 9.97 2.34 4.57-1.63 6.92-5.26 7.47-9.92 1.15-9.73-8.97-17.85-19.28-15.53-6.3 1.42-10.96 5.04-12.74 11.37-2.04 7.26.31 13.45 5.45 18.82 3.26 3.4 6.38 6.95 9.31 10.64 1.6 2.01 2.11 4.52-.71 6.07-2.63 1.44-3.92-.49-5.4-2.42-2.33-3.05-4.84-6.02-7.61-8.67-5.57-5.33-8.62-11.86-8.65-19.79z"/><path d="M141.36,39.93c16.87.03 29.5 18.29 23.38 33.8-.83 2.09-1.82 4.12-4.52 3.4-3.01-.81-3.25-3.05-2.27-5.66 2.8-7.43.66-13.83-4.56-19.23-4.73-4.9-10.71-6.3-17.21-4.28-6.5 2.02-10.46 6.61-11.79 13.29-1.61 8.05 5.57 15.83 13.53 14.78 5.13-.68 8.85-5.58 7.9-10.42-.89-4.52-6.22-6.96-9.4-4.31-2.5 2.09-2.42 5.03.45 6.31 2.69 1.19 3.92 2.89 2.56 5.52-1.38 2.64-3.78 1.86-5.9.91-4.57-2.04-6.91-7.22-5.63-12.23 1.32-5.16 6.67-9.04 12.1-8.78 8.51.41 14.8 8.79 12.86 17.13-2.35 10.1-12.46 15.61-22.31 12.17-10.51-3.67-15.96-15.12-12.32-25.88 3.42-10.1 12.86-16.83 23.23-16.82z"/><path d="M274.68,59.42c-.03 12.74-9.81 22.05-21.09 20.97-6.34-.6-10.9-4.06-13.55-9.85-2.45-5.36-1.87-10.49 1.74-15.15 3.49-4.51 9.85-6.34 14.76-4.4 5.14 2.03 8.09 6.73 7.58 12.07-.4 4.17-3.5 8.04-7.59 8.67-1.34.21-3.9-.83-4.13-1.75-.34-1.34.46-3.79 1.58-4.52 2.24-1.45 4.09-2.56 2.58-5.51-1.31-2.56-4.33-3.3-7.1-1.83-3.27 1.74-4.53 5.72-2.98 9.41 2.05 4.88 7.63 7.07 12.86 5.05 6.68-2.58 9.88-10.03 7.31-17.01-3.08-8.36-12.18-13.09-20.57-10.69-8.93 2.56-15.01 12.19-13.11 20.84.29 1.33 1.24 2.7 1.05 3.92-.24 1.6-1.31 3.06-2.02 4.59-1.51-.75-4.08-1.23-4.34-2.28-1.03-4.16-2.11-8.57-1.75-12.77.99-11.72 11.47-21.28 23.33-22.08 11.24-.76 21.77 6.99 24.74 18.29.48 1.76.61 3.52.7 4.14z"/><path d="M150.45,100.94c1.22-1.08 2.45-3.04 3.7-3.05 1.32-.01 3.12 1.58 3.86 2.94 1.04 1.91 1.64 4.23 1.74 6.41.07 1.45-.83 3.99-1.73 4.2-1.36.33-3.88-.5-4.53-1.63-1.39-2.41-1.9-5.33-3.04-8.87z"/><path d="M151.66,90.67c.83-3.52 1.04-6.1 2.11-8.25.57-1.16 3.04-2.51 3.91-2.11 1.26.57 2.43 2.58 2.57 4.08.18 2.01-.71 4.1-1.04 6.18-.36 2.27-1.61 4.07-3.86 3.43-1.55-.44-2.67-2.36-3.69-3.33z"/><path d="M156.8,127.86c2.91 2.65 5.78 5.07 8.34 7.78.44.47-.09 2.63-.82 3.25-.86.73-2.8 1.26-3.61.77-2.61-1.58-5.07-3.5-7.24-5.64-.65-.64-.51-2.63-.03-3.68.43-.93 1.83-1.41 3.36-2.48z"/><path d="M237.51,100.39c-.99 3.32-1.4 6-2.63 8.23-.62 1.12-3.21 2.33-4.03 1.89-1.22-.67-2.24-2.74-2.3-4.26-.07-2.03.5-4.3 1.49-6.08.75-1.35 2.61-2.95 3.91-2.89 1.26.04 2.45 2.06 3.56 3.11z"/><path d="M238.45,125.2c.75 1.62 2.56 3.75 2.07 4.83-1.29 2.86-3.39 5.44-5.58 7.74-.64.68-2.96.48-3.98-.16-.84-.53-1.6-2.73-1.17-3.46 1.69-2.83 3.84-5.39 5.91-7.98.32-.41 1.12-.43 2.75-.97z"/><path d="M237.87,87.27c0 .87.34 1.99-.07 2.57-.9 1.26-2.15 3.08-3.32 3.12-1.14.04-2.93-1.64-3.38-2.94-.72-2.05-.98-4.49-.62-6.62.25-1.46 1.87-2.7 2.88-4.03 1.32 1.03 3.03 1.83 3.84 3.17.77 1.27.6 3.12.84 4.71z"/><path d="M143.76,114.26c.43.26 1.41.6 2.03 1.28 1.42 1.56 3.02 3.12 3.86 4.99.58 1.3.57 3.99-.21 4.5-1.17.77-3.69.84-4.81.04-1.84-1.31-3.25-3.42-4.41-5.44-1.43-2.51.3-5.33 3.54-5.37z"/><path d="M245.76,122.1c-2.21-.12-4.16-2.55-3.12-4.46 1.28-2.35 2.92-4.71 4.96-6.38 2.04-1.67 4.09-.43 5.02 1.88 1.01 2.54-4.12 9.11-6.86 8.96z"/><path d="M199.62,67.74c-1.04 1.08-1.91 2.69-3.12 3.01-1.08.28-3.12-.49-3.71-1.44-1.15-1.85-1.92-4.11-2.17-6.27-.13-1.12.96-3.16 1.9-3.44 1.2-.37 3.44.17 4.12 1.11 1.33 1.84 1.88 4.25 2.98 7.03z"/></svg>`;

export function renderStatusZone() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const settings = getSettings();

    const status = computeOverallStatus(getCircuitState());

    // Skip the very first baseline set — only announce subsequent transitions.
    if (_lastAnnouncedStatus !== null && _lastAnnouncedStatus !== status) {
        announceToScreenReader(`Status: ${status}`);
    }
    _lastAnnouncedStatus = status;

    const $dot = $drawer.find('.dle-status-dot');
    $dot.attr('aria-live', 'polite');
    $dot.removeClass('dle-status-ok dle-status-degraded dle-status-limited dle-status-offline');
    $dot.addClass(STATUS_CLASSES[status] || 'dle-status-offline');

    // F13: pulse on status transition. Force reflow between remove + add to restart the CSS animation.
    if (_lastStatusKey !== null && _lastStatusKey !== status) {
        $dot.removeClass('dle-status-changed');
        $dot[0]?.offsetWidth;
        $dot.addClass('dle-status-changed').off('animationend.statuschange').one('animationend.statuschange', function () {
            $(this).removeClass('dle-status-changed');
        });
    }
    _lastStatusKey = status;
    const statusDesc = STATUS_DESCRIPTIONS[status] || status;
    $dot.attr('title', `System status: ${status} — ${statusDesc}`);
    $dot.attr('aria-label', `System status: ${status} — ${statusDesc}`);

    // Mascot icon is driven by pipelinePhase, not generationLock — phases survive lock release.
    const isActive = !!indexing || pipelinePhase !== 'idle' || ds.stGenerating;
    const activitySvg = indexing
        ? STATUS_SVG_CHOOSING   // indexing reuses the choosing-lore mascot
        : pipelinePhase === 'choosing'
            ? STATUS_SVG_CHOOSING
            : (pipelinePhase !== 'idle' || ds.stGenerating)
                ? STATUS_SVG_WRITING
                : STATUS_SVG_IDLE;
    $dot.html(activitySvg);
    $dot.toggleClass('dle-status-active', isActive);

    // Phase progression: Indexing → Choosing Lore → Consulting Vault → Generating/Writing → Idle.
    const PHASE_LABELS = { choosing: 'Choosing Lore…', consulting: 'Consulting Vault…', generating: 'Generating…', writing: 'Writing…', searching: 'Searching…', flagging: 'Flagging…' };
    const pipelineText = indexing ? 'Indexing…' : PHASE_LABELS[pipelinePhase] || (ds.stGenerating ? 'Generating…' : 'Idle');
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Status: ${pipelineText}`).attr('aria-live', 'polite');

    const $skipBtn = $drawer.find('.dle-action-btn[data-action="skip-tools"]');
    $skipBtn.toggleClass('dle-toggle-active', suppressNextAgenticLoop);
    const $skipLabel = $skipBtn.find('.dle-action-label');
    if ($skipLabel.length) {
        $skipLabel.text(suppressNextAgenticLoop ? 'Skipping Next' : 'Skip Librarian');
    }
    $skipBtn.attr('title', suppressNextAgenticLoop
        ? 'Librarian will be skipped on the next reply (click to re-enable)'
        : 'Skip Librarian tools for next generation');
    if (_lastSkipToolsState !== null && _lastSkipToolsState !== suppressNextAgenticLoop) {
        $skipBtn.removeClass('dle-skip-tools-pulse');
        requestAnimationFrame(() => {
            $skipBtn.addClass('dle-skip-tools-pulse').off('animationend.skiptoolspulse').one('animationend.skiptoolspulse', function () {
                $(this).removeClass('dle-skip-tools-pulse');
            });
        });
    }
    _lastSkipToolsState = suppressNextAgenticLoop;

    const $setupBanner = $drawer.find('.dle-setup-banner');
    const hasEnabledVaults = (settings.vaults || []).some(v => v.enabled);
    if (!hasEnabledVaults && !settings._wizardCompleted && !indexEverLoaded) {
        if (!$setupBanner.length) {
            const banner = `<div class="dle-setup-banner" role="status" style="padding: var(--dle-space-2) var(--dle-space-3); background: color-mix(in srgb, var(--dle-info) 15%, transparent); border-radius: 4px; margin: var(--dle-space-2) 0; display: flex; align-items: center; gap: var(--dle-space-2); font-size: var(--dle-text-sm);">
                <i class="fa-solid fa-wand-magic-sparkles" style="color: var(--dle-info);"></i>
                <span>New to DeepLore?</span>
                <button class="dle-setup-banner-btn menu_button" style="padding: 4px 12px; min-height: 28px; font-size: var(--dle-text-xs);" title="Run the setup wizard">Run Setup</button>
                <button class="dle-setup-banner-dismiss" style="margin-left: auto; background: none; border: none; cursor: pointer; opacity: 0.5; padding: 2px;" title="Dismiss" aria-label="Dismiss setup banner"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
            $drawer.find('.dle-zone-status').after(banner);
        }
    } else {
        $setupBanner.remove();
    }

    // Cold start: show loading shimmer instead of "0" stats before the first index build.
    if (!indexEverLoaded && vaultIndex.length === 0 && !indexing) {
        $drawer.find('[data-stat="entries"]').html('<span class="dle-shimmer">…</span>');
        $drawer.find('[data-stat="tokens"]').html('<span class="dle-shimmer">…</span>');
        $drawer.find('.dle-pipeline-label').text('Connecting to Obsidian…');
    }

    // Stat values get a flash animation on change. Verdict store holds the authoritative
    // trace + injected sources together — no fallback needed.
    const _statusVerdict = getCurrentVerdict();
    const entryCount = indexing ? '…' : vaultIndex.length;
    const $entries = $drawer.find('[data-stat="entries"]');
    if ($entries.text() !== String(entryCount)) {
        $entries.text(entryCount);
        const $eStat = $entries.closest('.dle-stat');
        $eStat.removeClass('dle-stat-changed');
        $eStat[0]?.offsetWidth; // force reflow → restart animation
        const _eStatEl = $eStat[0];
        $eStat.addClass('dle-stat-changed').off('animationend.statclean').one('animationend.statclean', function () { $(this).removeClass('dle-stat-changed'); });
        setTimeout(() => { if (_eStatEl) $(_eStatEl).removeClass('dle-stat-changed'); }, 600);
    }
    const vaultCount = settings.vaults?.filter(v => v.enabled !== false).length || 1;
    const entryTitle = indexing
        ? 'Loading lore entries...'
        : `${entryCount} lore entr${entryCount === 1 ? 'y' : 'ies'} loaded from ${vaultCount === 1 ? 'your Obsidian vault' : `${vaultCount} Obsidian vaults`}`;
    $entries.closest('.dle-stat').attr('title', entryTitle).attr('aria-label', entryTitle);

    const mode = settings.aiSearchEnabled !== false
        ? (MODE_LABELS[settings.aiSearchMode] || settings.aiSearchMode || '—')
        : 'Keywords';
    const modeKey = settings.aiSearchEnabled !== false ? (settings.aiSearchMode || 'two-stage') : 'keywords-only';
    const modeDesc = MODE_DESCRIPTIONS[modeKey] || mode;
    const modeTitle = `Search mode: ${mode} — ${modeDesc}`;
    $drawer.find('[data-stat="mode"]').text(mode).attr('title', modeTitle).attr('aria-label', modeTitle);

    // Token bar. When unlimited budget: bar shows proportion of total vault being injected
    // (used / total vault tokens) so users still see relative scale; floor at 1% so the bar is visible.
    const trace = _statusVerdict?.trace ?? null;
    const budget = settings.unlimitedBudget ? 0 : (settings.maxTokensBudget || 0);
    const used = trace?.totalTokens || 0;
    const totalVaultTokens = vaultIndex.length * (vaultAvgTokens || 200);
    const pct = budget
        ? Math.min(100, Math.round((used / (budget || 1)) * 100))
        : (settings.unlimitedBudget && used > 0 && totalVaultTokens > 0)
            ? Math.min(100, Math.round((used / totalVaultTokens) * 100)) || 1
            : 0;
    const $barContainer = $drawer.find('.dle-token-bar-container');
    $barContainer.attr('aria-valuenow', used).attr('aria-valuemax', budget);
    $barContainer.removeClass('dle-budget-high dle-budget-critical');
    if (pct >= 95) $barContainer.addClass('dle-budget-critical');
    else if (pct >= 80) $barContainer.addClass('dle-budget-high');
    $drawer.find('.dle-token-bar').css('width', `${pct}%`);
    const budgetLabel = budget
        ? `Budget: ${formatTokensCompact(used)} / ${formatTokensCompact(budget)}`
        : settings.unlimitedBudget
            ? `Budget: ${formatTokensCompact(used)} / \u221E`
            : 'Budget: waiting';
    $drawer.find('.dle-token-bar-label').text(budgetLabel);
    let breakdownParts = [];
    if (trace?.injected?.length) {
        const src = _statusVerdict?.injectedSources || [];
        const srcMap = new Map(src.map(s => [s.title, (s.matchedBy || '').toLowerCase()]));
        let constTokens = 0, keywordTokens = 0, aiTokens = 0, pinTokens = 0, otherTokens = 0;
        for (const e of trace.injected) {
            const reason = srcMap.get(e.title) || '';
            if (reason.includes('constant') || reason.includes('always')) constTokens += e.tokens;
            else if (reason.startsWith('ai:') || reason.includes('ai selection')) aiTokens += e.tokens;
            else if (reason.includes('pinned')) pinTokens += e.tokens;
            else if (reason.includes('fuzzy') || reason.includes('keyword') || reason.includes('(')) keywordTokens += e.tokens;
            else otherTokens += e.tokens;
        }
        if (constTokens) breakdownParts.push(`Constants: ${formatTokensCompact(constTokens)}`);
        if (keywordTokens) breakdownParts.push(`Keyword: ${formatTokensCompact(keywordTokens)}`);
        if (aiTokens) breakdownParts.push(`AI: ${formatTokensCompact(aiTokens)}`);
        if (pinTokens) breakdownParts.push(`Pinned: ${formatTokensCompact(pinTokens)}`);
        if (otherTokens) breakdownParts.push(`Other: ${formatTokensCompact(otherTokens)}`);
    }
    const breakdownStr = breakdownParts.length ? `\n${breakdownParts.join(' | ')}` : '';
    const tokenTitle = budget
        ? `Lore budget: ${formatTokensCompact(used)} of ${formatTokensCompact(budget)} tokens used${breakdownStr}`
        : settings.unlimitedBudget
            ? `Lore budget: ${formatTokensCompact(used)} tokens used (unlimited)${breakdownStr}`
            : 'Lore budget: waiting for first generation';
    $barContainer.attr('title', tokenTitle);

    const injectedNum = _statusVerdict?.injectedSources?.length ?? _statusVerdict?.trace?.injected?.length ?? 0;
    const maxEntries = settings.unlimitedEntries ? 0 : (settings.maxEntries || 0);
    const entriesPct = maxEntries
        ? Math.min(100, Math.round((injectedNum / maxEntries) * 100))
        : (settings.unlimitedEntries && injectedNum > 0 && vaultIndex.length > 0)
            ? Math.min(100, Math.round((injectedNum / vaultIndex.length) * 100)) || 1
            : 0;
    const $entriesBarContainer = $drawer.find('.dle-entries-bar-container');
    $entriesBarContainer.toggleClass('dle-indexing-shimmer', !!indexing);
    $entriesBarContainer.attr('aria-valuenow', injectedNum).attr('aria-valuemax', maxEntries);
    $entriesBarContainer.removeClass('dle-budget-high dle-budget-critical');
    if (entriesPct >= 95) $entriesBarContainer.addClass('dle-budget-critical');
    else if (entriesPct >= 80) $entriesBarContainer.addClass('dle-budget-high');
    $drawer.find('.dle-entries-bar').css('width', `${entriesPct}%`);
    const entriesLabel = maxEntries
        ? `Entries | ${injectedNum} / ${maxEntries}`
        : settings.unlimitedEntries
            ? `Entries | ${injectedNum} / \u221E`
            : 'Entries | waiting';
    $drawer.find('.dle-entries-bar-label').text(entriesLabel);
    const entriesTitle = maxEntries
        ? `${injectedNum} of ${maxEntries} entr${maxEntries === 1 ? 'y' : 'ies'} injected — limits how many lore entries are included per message`
        : settings.unlimitedEntries
            ? `${injectedNum} entr${injectedNum === 1 ? 'y' : 'ies'} injected (unlimited) — no entry count cap configured`
            : 'Entry limit: waiting for first generation';
    $entriesBarContainer.attr('title', entriesTitle);

    const ctx = chat_metadata?.deeplore_context;
    const $filters = $drawer.find('.dle-active-filters');
    const chips = [];
    const activeFolders = chat_metadata?.deeplore_folder_filter || [];
    const xBtn = (label) => `<button type="button" class="dle-chip-x" aria-label="Remove filter: ${escapeHtml(label)}" title="Remove filter"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    if (activeFolders.length > 0) {
        const folderLabel = activeFolders.length === 1 ? activeFolders[0] : `${activeFolders.length} folders`;
        chips.push(`<span class="dle-chip dle-chip-sm dle-folder-badge-chip" role="button" aria-pressed="true" tabindex="0" title="Folder filter active: ${escapeHtml(activeFolders.join(', '))}" data-action="goto-gating"><i class="fa-solid fa-folder" aria-hidden="true" style="margin-right:3px;font-size:0.8em;"></i>${escapeHtml(folderLabel)}<button type="button" class="dle-chip-x dle-chip-x-folder" aria-label="Clear folder filter" title="Clear folder filter"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
    }
    if (ctx) {
        for (const [key, val] of Object.entries(ctx)) {
            if (val == null || val === '') continue;
            if (Array.isArray(val)) {
                for (const v of val) chips.push(`<span class="dle-chip dle-chip-sm dle-gating-value-chip" role="button" tabindex="0" data-action="goto-gating" data-ctx-key="${escapeHtml(key)}" data-ctx-val="${escapeHtml(v)}" aria-label="${escapeHtml(key)}: ${escapeHtml(v)} — click to open Filters tab">${escapeHtml(v)}${xBtn(`${key}: ${v}`)}</span>`);
            } else {
                chips.push(`<span class="dle-chip dle-chip-sm dle-gating-value-chip" role="button" tabindex="0" data-action="goto-gating" data-ctx-key="${escapeHtml(key)}" data-ctx-val="${escapeHtml(val)}" aria-label="${escapeHtml(key)}: ${escapeHtml(val)} — click to open Filters tab">${escapeHtml(val)}${xBtn(`${key}: ${val}`)}</span>`);
            }
        }
    }
    // "Clear all" chip when 2+ active filter chips are visible.
    if (chips.length >= 2) {
        chips.push('<button type="button" class="dle-chip dle-chip-sm dle-chip-clear-all" aria-label="Clear all active filters" title="Clear all active filters">Clear all ×</button>');
    }
    // Claude adaptive-thinking misconfiguration: persistent chip rather than spammy toasts.
    // ds.reasoningWarningDismissed is session-scoped — re-shown after reload.
    if (claudeAutoEffortBad && claudeAutoEffortDetail && !ds.reasoningWarningDismissed) {
        const d = claudeAutoEffortDetail;
        const tip = `${d.modelName || 'Claude'} on profile "${d.profileName || '?'}" needs reasoning_effort set on preset "${d.presetName || '?'}" (Low/Medium/High). Click to open settings.`;
        chips.push(`<button type="button" class="dle-chip dle-chip-sm dle-chip-warn dle-reasoning-warning-btn" title="${escapeHtml(tip)}" data-action="goto-ai-connections" aria-label="Reasoning Effort misconfigured — click to open settings" style="background:color-mix(in srgb, var(--dle-warning, #d97706) 20%, transparent);color:var(--dle-warning, #d97706);display:inline-flex;align-items:center;gap:3px;cursor:pointer;border:none;"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true" style="font-size:0.8em;"></i>Reasoning Effort<span class="dle-chip-dismiss" role="button" tabindex="0" aria-label="Dismiss warning" style="margin-left:4px;opacity:0.7;font-size:1em;line-height:1;">×</span></button>`);
    }

    if (chips.length > 0) {
        $filters.html(chips.join(''));
        $filters.show();
    } else {
        $filters.empty().hide();
    }

    updateTabBadges();
}

export function updateTabBadges() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    // Verdict store holds injectedSources + trace together; either path resolves count.
    const _badgeVerdict = getCurrentVerdict();
    const injCount = _badgeVerdict?.injectedSources?.length ?? _badgeVerdict?.trace?.injected?.length ?? 0;
    $drawer.find('[data-badge="injection"]').text(injCount || '');

    const browseTotal = vaultIndex?.length || 0;
    const hasActiveFilters = ds.browseQuery || ds.browseStatusFilter !== 'all' || ds.browseTagFilter || ds.browseFolderFilter || Object.keys(ds.browseCustomFieldFilters).length > 0;
    const browseLabel = hasActiveFilters && ds.browseFilteredEntries.length !== browseTotal
        ? `${ds.browseFilteredEntries.length}/${browseTotal}`
        : (browseTotal || '');
    $drawer.find('[data-badge="browse"]').text(browseLabel);

    const gatingCtx = chat_metadata?.deeplore_context;
    let gatingCount = 0;
    if (gatingCtx) {
        for (const val of Object.values(gatingCtx)) {
            if (val == null || val === '') continue;
            if (Array.isArray(val)) gatingCount += val.length;
            else gatingCount++;
        }
    }
    const gatingFolders = chat_metadata?.deeplore_folder_filter;
    if (gatingFolders?.length) gatingCount += gatingFolders.length;
    $drawer.find('[data-badge="gating"]').text(gatingCount || '');
}
