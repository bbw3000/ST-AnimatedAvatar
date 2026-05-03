import { eventSource, event_types, getRequestHeaders } from '../../../../script.js';

const MODULE_NAME = 'AnimatedAvatar';
const EXTENSION_KEY = 'animated_avatar';
const BASE_URL = new URL('.', import.meta.url).href;
const ZOOM_WINDOW_STORAGE_KEY = 'AnimatedAvatar.zoomWindow';
const ZOOM_HOVER_STORAGE_KEY = 'AnimatedAvatar.zoomHoverEnabled';
const LONG_PRESS_MS = 650;
const LONG_PRESS_MOVE_PX = 12;

const defaultConfig = Object.freeze({
    version: 1,
    url: '',
    fit: {
        scale: 1,
        x: 50,
        y: 50,
        rotate: 0,
        flipX: false,
        flipY: false,
    },
    filter: {
        brightness: 1,
        contrast: 1,
        saturate: 1,
    },
});

let uiReady = false;
let activeCharacterId = null;
let draftConfig = null;
let intersectionObserver = null;
let pendingScan = false;
let zoomState = null;
let zoomHoverEnabled = true;

const resetValues = Object.freeze({
    'aa-scale': 1,
    'aa-offset-x': 50,
    'aa-offset-y': 50,
    'aa-rotate': 0,
    'aa-brightness': 1,
    'aa-contrast': 1,
    'aa-saturate': 1,
    'aa-flip-x': false,
    'aa-flip-y': false,
});

function getST() {
    return globalThis.SillyTavern.getContext();
}

function cloneConfig(config = {}) {
    return {
        version: 1,
        url: String(config.url || ''),
        fit: {
            scale: Number(config.fit?.scale ?? defaultConfig.fit.scale),
            x: Number(config.fit?.x ?? defaultConfig.fit.x),
            y: Number(config.fit?.y ?? defaultConfig.fit.y),
            rotate: Number(config.fit?.rotate ?? defaultConfig.fit.rotate),
            flipX: !!config.fit?.flipX,
            flipY: !!config.fit?.flipY,
        },
        filter: {
            brightness: Number(config.filter?.brightness ?? defaultConfig.filter.brightness),
            contrast: Number(config.filter?.contrast ?? defaultConfig.filter.contrast),
            saturate: Number(config.filter?.saturate ?? defaultConfig.filter.saturate),
        },
    };
}

function getCharacterConfig(character) {
    return cloneConfig(character?.data?.extensions?.[EXTENSION_KEY] || {});
}

function getCharacterStaticUrl(character) {
    if (!character?.avatar) return '';
    const context = getST();
    return context.getThumbnailUrl ? context.getThumbnailUrl('avatar', character.avatar) : `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`;
}

function getCurrentCharacter() {
    const context = getST();
    return context.characters?.[context.characterId] || null;
}

function getMessageByElement(messageElement) {
    const mesId = Number(messageElement?.getAttribute('mesid'));
    if (!Number.isInteger(mesId)) return null;
    return getST().chat?.[mesId] || null;
}

function getAvatarFileFromUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, location.origin);
        const file = parsed.searchParams.get('file');
        if (file) return decodeURIComponent(file);
        const pathname = parsed.pathname;
        if (/\/characters\//i.test(pathname) && pathname.includes('http')) return '';
        const name = pathname.split('/').pop();
        return decodeURIComponent(name || '');
    } catch (_) {
        return '';
    }
}

function getCharacterByMessageName(message) {
    const messageCharacterName = message?.ch_name || message?.name || '';
    if (!messageCharacterName) return null;
    const context = getST();
    return context.characters?.find(character => character.name === messageCharacterName || character.data?.name === messageCharacterName) || null;
}

function getCharacterForMessageElement(messageElement) {
    const message = getMessageByElement(messageElement);
    if (!message || message.is_user) return null;

    const context = getST();
    const avatarFile = message.original_avatar || getAvatarFileFromUrl(message.force_avatar);
    if (avatarFile) {
        const matched = context.characters?.find(character => character.avatar === avatarFile);
        if (matched) return matched;
    }

    const namedCharacter = getCharacterByMessageName(message);
    if (namedCharacter) return namedCharacter;

    if (message.is_system || message.hide || context.groupId) return null;

    const current = getCurrentCharacter();
    return current || null;
}

function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
}

function clampScale(value) {
    return Math.max(1, value);
}

function applyConfigToImage(img, config) {
    const fit = config.fit || defaultConfig.fit;
    const filter = config.filter || defaultConfig.filter;
    const flipX = fit.flipX ? -1 : 1;
    const flipY = fit.flipY ? -1 : 1;
    const scale = clampScale(Number(fit.scale ?? defaultConfig.fit.scale));
    const hoverScale = 'var(--aa-zoom-hover-scale, 1)';

    img.style.objectFit = 'cover';
    img.style.objectPosition = '50% 50%';
    img.style.position = 'absolute';
    img.style.top = `${clampPercent(Number(fit.y ?? 0))}%`;
    img.style.left = `${clampPercent(Number(fit.x ?? 0))}%`;
    img.style.transformOrigin = 'center center';
    img.style.transform = `translate(-50%, -50%) rotate(${fit.rotate}deg) scale(calc(${scale * flipX} * ${hoverScale}), calc(${scale * flipY} * ${hoverScale}))`;
    img.style.filter = `brightness(${filter.brightness}) contrast(${filter.contrast}) saturate(${filter.saturate})`;
}

function clearImageEffects(img) {
    img.style.objectFit = '';
    img.style.objectPosition = '';
    img.style.position = '';
    img.style.top = '';
    img.style.left = '';
    img.style.transformOrigin = '';
    img.style.transform = '';
    img.style.filter = '';
    img.style.visibility = '';
}

function getAvatarFrame(img) {
    return img.closest('.aa-avatar-frame');
}

function setAvatarFrameActive(img, active) {
    const frame = getAvatarFrame(img);
    if (frame) frame.style.removeProperty('display');
    img.style.visibility = active ? 'visible' : '';
}

function ensureAvatarFrame(img) {
    const existing = getAvatarFrame(img);
    if (existing) return existing;

    const parent = img.parentElement;
    if (!parent) return null;

    const frame = document.createElement('span');
    frame.className = 'aa-avatar-frame';
    parent.insertBefore(frame, img);
    frame.appendChild(img);
    return frame;
}

function restoreAvatarFrame(img) {
    const frame = getAvatarFrame(img);
    const parent = frame?.parentElement;
    if (!frame || !parent) return;
    parent.insertBefore(img, frame);
    frame.remove();
}

function getZoomSrc(img) {
    if (img?.dataset?.aaActive === '1' && img.dataset.aaAnimatedSrc) return img.dataset.aaAnimatedSrc;
    return img?.dataset?.aaStaticSrc || img?.src || '';
}

function syncZoomClickSource(img) {
    const src = getZoomSrc(img);
    if (!src) return;
    img.dataset.aaZoomSrc = src;
}

function resolveZoomAvatarSrc(messageElement, thumbUrl) {
    const img = messageElement?.querySelector('.avatar img');
    if (img?.dataset?.aaZoomSrc) return img.dataset.aaZoomSrc;
    return thumbUrl || '';
}

function patchZoomedAvatarClick() {
    if (patchZoomedAvatarClick.bound) return;
    patchZoomedAvatarClick.bound = true;

    document.addEventListener('click', event => {
        const avatar = event.target?.closest?.('.mes .avatar');
        if (!avatar) return;

        const messageElement = avatar.closest('.mes');
        const message = getMessageByElement(messageElement);
        const namedCharacter = getCharacterByMessageName(message);
        const character = namedCharacter || getCharacterForMessageElement(messageElement);
        const config = getCharacterConfig(character);
        if (!character || !config.url) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openZoomViewer(config, character);
    }, true);
}

function saveZoomWindowState(viewer) {
    if (!viewer) return;
    const state = {
        left: viewer.style.left || `${viewer.getBoundingClientRect().left}px`,
        top: viewer.style.top || `${viewer.getBoundingClientRect().top}px`,
        width: viewer.style.width || `${viewer.getBoundingClientRect().width}px`,
        height: viewer.style.height || `${viewer.getBoundingClientRect().height}px`,
    };
    try {
        localStorage.setItem(ZOOM_WINDOW_STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
        /* ignore */
    }
}

function loadZoomWindowState() {
    try {
        const raw = localStorage.getItem(ZOOM_WINDOW_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function loadZoomHoverEnabled() {
    try {
        return localStorage.getItem(ZOOM_HOVER_STORAGE_KEY) !== '0';
    } catch (_) {
        return true;
    }
}

function saveZoomHoverEnabled() {
    try {
        localStorage.setItem(ZOOM_HOVER_STORAGE_KEY, zoomHoverEnabled ? '1' : '0');
    } catch (_) {
        /* ignore */
    }
}

function syncZoomHoverToggle() {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const toggle = document.getElementById('aa-zoom-hover-toggle');
    if (!backdrop || !toggle) return;
    const available = !backdrop.classList.contains('aa-zoom-fullscreen');
    toggle.hidden = !available;
    toggle.setAttribute('aria-pressed', zoomHoverEnabled ? 'true' : 'false');
    toggle.title = zoomHoverEnabled ? 'Disable hover zoom' : 'Enable hover zoom';
    backdrop.classList.toggle('aa-zoom-hover-disabled', !zoomHoverEnabled);
}

function toggleZoomHover(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    zoomHoverEnabled = !zoomHoverEnabled;
    saveZoomHoverEnabled();
    syncZoomHoverToggle();
    if (!zoomHoverEnabled) resetWindowZoomFocus();
}

function restoreZoomWindowState(viewer) {
    const state = loadZoomWindowState();
    if (!viewer || !state) return;
    if (state.left) viewer.style.left = state.left;
    if (state.top) viewer.style.top = state.top;
    if (state.width) viewer.style.width = state.width;
    if (state.height) viewer.style.height = state.height;
}

function getNaturalSize(img) {
    return {
        width: Math.max(1, img.naturalWidth || 1),
        height: Math.max(1, img.naturalHeight || 1),
    };
}

function fitSizeToBox(width, height, maxWidth, maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
    return {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio)),
    };
}

function applyZoomPan() {
    const img = document.getElementById('aa-zoom-img');
    if (!img || !zoomState) return;
    img.style.setProperty('--aa-zoom-pan-x', `${zoomState.panX}px`);
    img.style.setProperty('--aa-zoom-pan-y', `${zoomState.panY}px`);
}

function applyZoomImageFit() {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const viewer = document.getElementById('aa-zoom-viewer');
    const img = document.getElementById('aa-zoom-img');
    if (!backdrop || !viewer || !img || !zoomState) return;

    const natural = getNaturalSize(img);
    if (backdrop.classList.contains('aa-zoom-fullscreen')) {
        const fitted = fitSizeToBox(natural.width, natural.height, window.innerWidth || natural.width, window.innerHeight || natural.height);
        img.style.width = `${fitted.width}px`;
        img.style.height = `${fitted.height}px`;
        img.style.setProperty('--aa-zoom-scale', String(zoomState.scale));
        applyZoomPan();
        return;
    }

    const rect = viewer.getBoundingClientRect();
    img.style.width = `${rect.width}px`;
    img.style.height = `${rect.height}px`;
    img.style.removeProperty('--aa-zoom-pan-x');
    img.style.removeProperty('--aa-zoom-pan-y');
}

function setZoomMode() {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const viewer = document.getElementById('aa-zoom-viewer');
    if (!backdrop || !viewer) return;

    const fullscreen = isMobileLayout();
    backdrop.classList.toggle('aa-zoom-fullscreen', fullscreen);
    syncZoomHoverToggle();
    if (fullscreen) {
        viewer.style.top = '';
        viewer.style.left = '';
        viewer.style.width = '';
        viewer.style.height = '';
        if (zoomState) zoomState.scale = Math.max(1, zoomState.scale || 1);
    } else if (zoomState) {
        zoomState.scale = 1;
        zoomState.panX = 0;
        zoomState.panY = 0;
        if (!viewer.style.width || !viewer.style.height) {
            const img = document.getElementById('aa-zoom-img');
            if (img) initializeZoomWindowSize(img);
        }
        clampZoomWindow(viewer);
    }
    applyZoomImageFit();
}

function initializeZoomWindowSize(img) {
    const viewer = document.getElementById('aa-zoom-viewer');
    if (!viewer) return;

    const natural = getNaturalSize(img);
    const maxWidth = Math.max(1, Math.min(520, window.innerWidth - 24));
    const maxHeight = Math.max(1, Math.min(720, window.innerHeight - 24));
    const fitted = fitSizeToBox(natural.width, natural.height, maxWidth, maxHeight);
    viewer.style.width = `${fitted.width}px`;
    viewer.style.height = `${fitted.height}px`;
    if (!viewer.style.left) viewer.style.left = '96px';
    if (!viewer.style.top) viewer.style.top = '96px';
}

function openZoomViewer(config, character = null) {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const frame = document.getElementById('aa-zoom-frame');
    const img = document.getElementById('aa-zoom-img');
    if (!backdrop || !frame || !img || !config?.url) return;

    closeZoomViewer({ keepImage: true });
    zoomState = {
        pointerId: null,
        mode: null,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        scale: 1,
        panX: 0,
        panY: 0,
        startPanX: 0,
        startPanY: 0,
        activeCharacterAvatar: character?.avatar || '',
        pinchStartDistance: 0,
        pinchStartScale: 1,
        touches: new Map(),
    };
    if (backdrop) backdrop.style.display = 'block';
    if (frame) frame.classList.toggle('aa-zoom-fullscreen', isMobileLayout());
    syncZoomHoverToggle();
    if (img.src !== config.url) img.src = config.url;
    clearImageEffects(img);
    img.onload = () => {
        initializeZoomWindowSize(img);
        restoreZoomWindowState(document.getElementById('aa-zoom-viewer'));
        setZoomMode();
    };
    frame.addEventListener('pointerdown', startZoomDrag);
    frame.addEventListener('pointermove', moveZoomDrag);
    frame.addEventListener('pointermove', updateWindowZoomFocus);
    frame.addEventListener('pointerleave', resetWindowZoomFocus);
    frame.addEventListener('pointerup', endZoomDrag);
    frame.addEventListener('pointercancel', endZoomDrag);
    document.getElementById('aa-zoom-resize')?.addEventListener('pointerdown', startZoomResize);
}

function closeZoomViewer({ keepImage = false } = {}) {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const frame = document.getElementById('aa-zoom-frame');
    const resize = document.getElementById('aa-zoom-resize');
    const img = document.getElementById('aa-zoom-img');
    if (backdrop) backdrop.style.display = 'none';
    if (frame) {
        frame.removeEventListener('pointerdown', startZoomDrag);
        frame.removeEventListener('pointermove', moveZoomDrag);
        frame.removeEventListener('pointermove', updateWindowZoomFocus);
        frame.removeEventListener('pointerleave', resetWindowZoomFocus);
        frame.removeEventListener('pointerup', endZoomDrag);
        frame.removeEventListener('pointercancel', endZoomDrag);
    }
    resize?.removeEventListener('pointerdown', startZoomResize);
    document.removeEventListener('pointermove', moveZoomResize);
    document.removeEventListener('pointerup', endZoomResize);
    document.removeEventListener('pointercancel', endZoomResize);
    if (img) {
        clearImageEffects(img);
        img.style.removeProperty('--aa-zoom-scale');
        img.style.removeProperty('--aa-zoom-pan-x');
        img.style.removeProperty('--aa-zoom-pan-y');
        img.style.transformOrigin = '';
        img.onload = null;
        if (!keepImage) img.removeAttribute('src');
    }
    zoomState = null;
}

function clampZoomWindow(viewer) {
    const rect = viewer.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    viewer.style.left = `${Math.max(0, Math.min(maxLeft, rect.left))}px`;
    viewer.style.top = `${Math.max(0, Math.min(maxTop, rect.top))}px`;
}

function updateWindowZoomFocus(event) {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const frame = document.getElementById('aa-zoom-frame');
    const img = document.getElementById('aa-zoom-img');
    if (!backdrop || !frame || !img || backdrop.classList.contains('aa-zoom-fullscreen') || !zoomHoverEnabled) return;

    const rect = frame.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
    img.style.transformOrigin = `${clampPercent(x)}% ${clampPercent(y)}%`;
}

function resetWindowZoomFocus() {
    const img = document.getElementById('aa-zoom-img');
    if (img) img.style.transformOrigin = 'center center';
}

function startZoomDrag(event) {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const viewer = document.getElementById('aa-zoom-viewer');
    if (!zoomState || !viewer || event.target?.closest?.('#aa-zoom-close') || event.target?.closest?.('#aa-zoom-hover-toggle') || event.target?.closest?.('#aa-zoom-resize') || event.target?.closest?.('#aa-zoom-edit')) return;

    event.preventDefault();
    if (backdrop?.classList.contains('aa-zoom-fullscreen')) {
        zoomState.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (zoomState.touches.size === 2) {
            const points = Array.from(zoomState.touches.values());
            zoomState.mode = 'pinch';
            zoomState.pinchStartDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            zoomState.pinchStartScale = zoomState.scale;
        } else {
            zoomState.mode = 'pan';
            zoomState.pointerId = event.pointerId;
            zoomState.startX = event.clientX;
            zoomState.startY = event.clientY;
            zoomState.startPanX = zoomState.panX;
            zoomState.startPanY = zoomState.panY;
        }
        return;
    }

    const rect = viewer.getBoundingClientRect();
    zoomState.mode = 'move';
    zoomState.pointerId = event.pointerId;
    zoomState.startX = event.clientX;
    zoomState.startY = event.clientY;
    zoomState.startLeft = rect.left;
    zoomState.startTop = rect.top;
    event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveZoomDrag(event) {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const viewer = document.getElementById('aa-zoom-viewer');
    const img = document.getElementById('aa-zoom-img');
    if (!zoomState || !viewer || !img) return;

    if (backdrop?.classList.contains('aa-zoom-fullscreen')) {
        if (!zoomState.touches.has(event.pointerId)) return;
        zoomState.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (zoomState.mode === 'pinch' && zoomState.touches.size >= 2) {
            const points = Array.from(zoomState.touches.values());
            const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            const nextScale = zoomState.pinchStartScale * (distance / Math.max(1, zoomState.pinchStartDistance));
            zoomState.scale = Math.max(1, Math.min(4, nextScale));
            applyZoomImageFit();
        }
        if (zoomState.mode === 'pan' && zoomState.touches.size === 1) {
            event.preventDefault();
            zoomState.panX = zoomState.startPanX + (event.clientX - zoomState.startX);
            zoomState.panY = zoomState.startPanY + (event.clientY - zoomState.startY);
            applyZoomPan();
        }
        return;
    }

    if (zoomState.mode !== 'move' || event.pointerId !== zoomState.pointerId) return;
    event.preventDefault();
    viewer.style.left = `${zoomState.startLeft + event.clientX - zoomState.startX}px`;
    viewer.style.top = `${zoomState.startTop + event.clientY - zoomState.startY}px`;
    clampZoomWindow(viewer);
}

function endZoomDrag(event) {
    if (!zoomState) return;
    zoomState.touches.delete(event.pointerId);
    if (zoomState.mode === 'pinch' && zoomState.touches.size < 2) zoomState.mode = null;
    if (zoomState.mode === 'pan' && zoomState.touches.size < 1) zoomState.mode = null;
    if (zoomState.mode === 'move' && event.pointerId === zoomState.pointerId) {
        zoomState.mode = null;
        zoomState.pointerId = null;
        saveZoomWindowState(document.getElementById('aa-zoom-viewer'));
    }
}

function startZoomResize(event) {
    const backdrop = document.getElementById('aa-zoom-backdrop');
    const viewer = document.getElementById('aa-zoom-viewer');
    if (!zoomState || !viewer || backdrop?.classList.contains('aa-zoom-fullscreen')) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = viewer.getBoundingClientRect();
    zoomState.mode = 'resize';
    zoomState.pointerId = event.pointerId;
    zoomState.startX = event.clientX;
    zoomState.startY = event.clientY;
    zoomState.startWidth = rect.width;
    zoomState.startHeight = rect.height;
    document.addEventListener('pointermove', moveZoomResize);
    document.addEventListener('pointerup', endZoomResize);
    document.addEventListener('pointercancel', endZoomResize);
}

function moveZoomResize(event) {
    const viewer = document.getElementById('aa-zoom-viewer');
    const img = document.getElementById('aa-zoom-img');
    if (!zoomState || !viewer || !img || zoomState.mode !== 'resize' || event.pointerId !== zoomState.pointerId) return;

    event.preventDefault();
    const natural = getNaturalSize(img);
    const maxWidth = Math.max(1, window.innerWidth - 24);
    const maxHeight = Math.max(1, window.innerHeight - 24);
    const ratio = natural.width / natural.height;
    const nextWidth = Math.max(180, Math.min(maxWidth, zoomState.startWidth + event.clientX - zoomState.startX));
    const nextHeight = nextWidth / ratio;
    if (nextHeight > maxHeight) {
        viewer.style.height = `${maxHeight}px`;
        viewer.style.width = `${maxHeight * ratio}px`;
    } else {
        viewer.style.width = `${nextWidth}px`;
        viewer.style.height = `${Math.max(120, nextHeight)}px`;
    }
    applyZoomImageFit();
    clampZoomWindow(viewer);
}

function endZoomResize(event) {
    if (!zoomState || event.pointerId !== zoomState.pointerId) return;
    saveZoomWindowState(document.getElementById('aa-zoom-viewer'));
    zoomState.mode = null;
    zoomState.pointerId = null;
    document.removeEventListener('pointermove', moveZoomResize);
    document.removeEventListener('pointerup', endZoomResize);
    document.removeEventListener('pointercancel', endZoomResize);
}

function openZoomEditor() {
    const character = zoomState?.activeCharacterAvatar
        ? getST().characters?.find(item => item.avatar === zoomState.activeCharacterAvatar)
        : getCurrentCharacter();
    if (!character) return;
    closeZoomViewer({ keepImage: true });
    openEditor(character);
}

function getDisplayedSrcWithoutBreakingZoom(img, nextSrc) {
    img.dataset.aaZoomSrc = nextSrc;
    return nextSrc;
}

function activateMessageAvatar(img) {
    const character = getCharacterForMessageElement(img.closest('.mes'));
    const config = getCharacterConfig(character);
    if (!character || !config.url) return;

    ensureAvatarFrame(img);
    img.dataset.aaStaticSrc = getCharacterStaticUrl(character) || img.dataset.aaStaticSrc || img.src;
    img.dataset.aaAnimatedSrc = config.url;
    img.dataset.aaActive = '1';
    if (img.src !== config.url) img.src = getDisplayedSrcWithoutBreakingZoom(img, config.url);
    else syncZoomClickSource(img);
    setAvatarFrameActive(img, true);
    applyConfigToImage(img, config);
}

function deactivateMessageAvatar(img, { restoreStatic = false } = {}) {
    const staticSrc = img.dataset.aaStaticSrc;
    img.dataset.aaActive = '0';
    syncZoomClickSource(img);
    if (restoreStatic && staticSrc && img.src !== staticSrc) img.src = staticSrc;
    if (restoreStatic) clearImageEffects(img);
    if (restoreStatic) setAvatarFrameActive(img, false);
}

function ensureIntersectionObserver() {
    if (intersectionObserver) return intersectionObserver;
    intersectionObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const img = entry.target;
            if (!(img instanceof HTMLImageElement)) continue;
            if (entry.isIntersecting) activateMessageAvatar(img);
            else deactivateMessageAvatar(img);
        }
    }, { root: document.getElementById('chat'), rootMargin: '300px 0px 300px 0px', threshold: 0 });
    return intersectionObserver;
}

function registerMessage(messageElement) {
    if (!messageElement || messageElement.dataset.aaRegistered === '1') return;
    const character = getCharacterForMessageElement(messageElement);
    if (!character) return;

    const config = getCharacterConfig(character);
    const wrapper = messageElement.querySelector('.mesAvatarWrapper');
    const img = messageElement.querySelector('.avatar img');
    if (!wrapper || !img) return;

    messageElement.dataset.aaRegistered = '1';
    if (config.url) {
        ensureAvatarFrame(img);
        img.dataset.aaStaticSrc = getCharacterStaticUrl(character) || img.src;
        ensureIntersectionObserver().observe(img);
    } else {
        restoreAvatarFrame(img);
        if (intersectionObserver) intersectionObserver.unobserve(img);
        delete img.dataset.aaStaticSrc;
        delete img.dataset.aaAnimatedSrc;
        delete img.dataset.aaActive;
        delete img.dataset.aaZoomSrc;
    }
    ensureEditButton(wrapper, messageElement);
    ensureLongPress(wrapper, messageElement);
}

function scheduleScan() {
    if (pendingScan) return;
    pendingScan = true;
    requestAnimationFrame(() => {
        pendingScan = false;
        document.querySelectorAll('#chat .mes').forEach(registerMessage);
    });
}

function refreshRegisteredAvatars() {
    document.querySelectorAll('#chat .mes').forEach(messageElement => {
        delete messageElement.dataset.aaRegistered;
        const img = messageElement.querySelector('.avatar img');
        if (img && intersectionObserver) {
            intersectionObserver.unobserve(img);
            deactivateMessageAvatar(img, { restoreStatic: true });
            restoreAvatarFrame(img);
        }
        registerMessage(messageElement);
    });
}

function ensureEditButton(wrapper, messageElement) {
    if (wrapper.querySelector('.aa-avatar-edit-button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'aa-avatar-edit-button';
    button.title = 'Edit animated avatar';
    button.textContent = 'Edit';
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const character = getCharacterForMessageElement(messageElement);
        if (character) openEditor(character);
    });
    wrapper.appendChild(button);
}

function ensureLongPress(wrapper, messageElement) {
    if (wrapper.dataset.aaLongPress === '1') return;
    wrapper.dataset.aaLongPress = '1';

    let timer = null;
    let startX = 0;
    let startY = 0;

    const clear = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };

    wrapper.addEventListener('touchstart', event => {
        if (!isMobileLayout()) return;
        const touch = event.touches?.[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
        clear();
        timer = setTimeout(() => {
            const character = getCharacterForMessageElement(messageElement);
            if (character) openEditor(character);
        }, LONG_PRESS_MS);
    }, { passive: true });

    wrapper.addEventListener('touchmove', event => {
        const touch = event.touches?.[0];
        if (!touch) return;
        if (Math.abs(touch.clientX - startX) > LONG_PRESS_MOVE_PX || Math.abs(touch.clientY - startY) > LONG_PRESS_MOVE_PX) clear();
    }, { passive: true });
    wrapper.addEventListener('touchend', clear, { passive: true });
    wrapper.addEventListener('touchcancel', clear, { passive: true });
}

function isMobileLayout() {
    const sheld = document.getElementById('sheld');
    if (!sheld) return window.innerWidth <= 768;
    const sheldWidth = sheld.getBoundingClientRect().width;
    const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    return sheldWidth >= viewportWidth - 4;
}

function applyResponsiveMode() {
    const win = document.getElementById('aa-window');
    if (win) {
        win.classList.toggle('aa-mobile', isMobileLayout());
        win.classList.toggle('aa-fullscreen', isMobileLayout());
    }
    setZoomMode();
}

async function loadUI() {
    if (uiReady) return;
    const response = await fetch(BASE_URL + 'index.html');
    if (!response.ok) throw new Error(`Failed to load AnimatedAvatar UI: ${response.status}`);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = await response.text();
    while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);
    bindUIEvents();
    zoomHoverEnabled = loadZoomHoverEnabled();
    syncZoomHoverToggle();
    uiReady = true;
}

function resetControl(button) {
    const targetId = button?.dataset?.resetTarget;
    const groupId = button?.dataset?.resetGroup;
    const resetAll = button?.dataset?.resetAll === 'true';

    if (resetAll) {
        setControlsFromConfig(cloneConfig());
        readControlsToDraft();
        return;
    }

    for (const id of [targetId, groupId].filter(Boolean)) {
        const input = document.getElementById(id);
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = !!resetValues[id];
        else input.value = String(resetValues[id]);
    }
    readControlsToDraft();
}

function bindUIEvents() {
    window.addEventListener('resize', applyResponsiveMode);
    document.getElementById('aa-backdrop')?.addEventListener('click', closeEditor);
    document.getElementById('aa-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('aa-save')?.addEventListener('click', saveEditor);
    document.getElementById('aa-remove')?.addEventListener('click', removeConfig);
    document.getElementById('aa-url-confirm')?.addEventListener('click', confirmUrl);
    document.getElementById('aa-url-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') confirmUrl();
    });

    document.querySelectorAll('#aa-window input[type="range"], #aa-window input[type="checkbox"]').forEach(input => {
        input.addEventListener('pointerdown', event => event.stopPropagation());
        input.addEventListener('input', readControlsToDraft);
        input.addEventListener('change', readControlsToDraft);
    });

    document.querySelectorAll('#aa-window .aa-reset-btn').forEach(button => {
        button.addEventListener('click', () => resetControl(button));
    });

    const preview = document.getElementById('aa-animated-preview');
    const stage = document.getElementById('aa-animated-stage');
    const controls = document.querySelector('#aa-window .aa-controls-overlay');
    const toggleControls = event => {
        event?.stopPropagation?.();
        if (stage) stage.classList.toggle('aa-controls-open');
    };

    if (controls) {
        controls.addEventListener('pointerdown', event => event.stopPropagation());
        controls.addEventListener('pointermove', event => event.stopPropagation());
        const hint = controls.querySelector('.aa-controls-hint');
        hint?.addEventListener('click', toggleControls);
    }

    if (preview) {
        preview.addEventListener('click', toggleControls);
    }

    const zoomClose = document.getElementById('aa-zoom-close');
    zoomClose?.addEventListener('click', closeZoomViewer);
    const zoomHoverToggle = document.getElementById('aa-zoom-hover-toggle');
    zoomHoverToggle?.addEventListener('click', toggleZoomHover);
    const zoomEdit = document.getElementById('aa-zoom-edit');
    zoomEdit?.addEventListener('click', openZoomEditor);
}

function setStatus(text) {
    const line = document.getElementById('aa-url-status');
    if (line) line.textContent = text || '';
}

function preloadImage(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(url);
        image.onerror = () => reject(new Error('Image failed to load'));
        image.src = url;
    });
}

async function confirmUrl() {
    const input = document.getElementById('aa-url-input');
    const url = String(input?.value || '').trim();
    if (!url) return;

    setStatus('Loading...');
    try {
        new URL(url, location.href);
        await preloadImage(url);
        draftConfig.url = url;
        setControlsFromConfig(draftConfig);
        renderEditorState({ reloadImage: true });
        setStatus('');
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to preload image`, error);
        setStatus('Could not load this image URL.');
    }
}

function openEditor(character) {
    if (!uiReady) return;
    const context = getST();
    const id = context.characters?.findIndex(item => item.avatar === character.avatar);
    if (!Number.isInteger(id) || id < 0) return;

    activeCharacterId = id;
    draftConfig = getCharacterConfig(character);

    const input = document.getElementById('aa-url-input');
    if (input) input.value = draftConfig.url || '';

    setControlsFromConfig(draftConfig);
    document.getElementById('aa-animated-stage')?.classList.remove('aa-controls-open');
    renderEditorState();
    applyResponsiveMode();

    const backdrop = document.getElementById('aa-backdrop');
    const win = document.getElementById('aa-window');
    if (backdrop) backdrop.style.display = 'block';
    if (win) win.style.display = 'flex';
}

function closeEditor() {
    const backdrop = document.getElementById('aa-backdrop');
    const win = document.getElementById('aa-window');
    if (backdrop) backdrop.style.display = 'none';
    if (win) win.style.display = 'none';
    activeCharacterId = null;
    draftConfig = null;
}

function renderEditorState({ reloadImage = false } = {}) {
    const empty = document.getElementById('aa-animated-empty');
    const editor = document.getElementById('aa-animated-editor');
    const preview = document.getElementById('aa-animated-preview');
    const hasUrl = !!draftConfig?.url;

    if (empty) empty.style.display = hasUrl ? 'none' : 'flex';
    if (editor) editor.style.display = hasUrl ? 'flex' : 'none';
    if (preview && hasUrl) {
        if (reloadImage || preview.src !== draftConfig.url) {
            preview.src = draftConfig.url;
        }
        applyConfigToImage(preview, draftConfig);
        syncZoomClickSource(preview);
    }
}

function setControlsFromConfig(config) {
    const fit = config.fit || defaultConfig.fit;
    const filter = config.filter || defaultConfig.filter;
    setInputValue('aa-scale', clampScale(Number(fit.scale ?? defaultConfig.fit.scale)));
    setInputValue('aa-offset-x', clampPercent(Number(fit.x ?? defaultConfig.fit.x)));
    setInputValue('aa-offset-y', clampPercent(Number(fit.y ?? defaultConfig.fit.y)));
    setInputValue('aa-rotate', fit.rotate);
    setInputValue('aa-brightness', filter.brightness);
    setInputValue('aa-contrast', filter.contrast);
    setInputValue('aa-saturate', filter.saturate);
    setInputChecked('aa-flip-x', fit.flipX);
    setInputChecked('aa-flip-y', fit.flipY);
}

function setInputValue(id, value) {
    const input = document.getElementById(id);
    if (input) input.value = String(value);
}

function setInputChecked(id, value) {
    const input = document.getElementById(id);
    if (input) input.checked = !!value;
}

function readControlsToDraft() {
    if (!draftConfig) return;
    const defaults = cloneConfig();
    draftConfig.fit ??= defaults.fit;
    draftConfig.filter ??= defaults.filter;
    draftConfig.fit = {
        ...draftConfig.fit,
        scale: clampScale(readNumber('aa-scale', draftConfig.fit?.scale ?? 1)),
        x: clampPercent(readNumber('aa-offset-x', draftConfig.fit?.x ?? 50)),
        y: clampPercent(readNumber('aa-offset-y', draftConfig.fit?.y ?? 50)),
        rotate: readNumber('aa-rotate', draftConfig.fit?.rotate ?? 0),
        flipX: readChecked('aa-flip-x'),
        flipY: readChecked('aa-flip-y'),
    };
    draftConfig.filter = {
        brightness: readNumber('aa-brightness', 1),
        contrast: readNumber('aa-contrast', 1),
        saturate: readNumber('aa-saturate', 1),
    };
    renderEditorState();
}

function readNumber(id, fallback) {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
}

function readChecked(id) {
    return !!document.getElementById(id)?.checked;
}

function getActiveCharacter() {
    if (activeCharacterId === null) return null;
    return getST().characters?.[activeCharacterId] || null;
}

function buildSavePayload(character) {
    const payload = cloneConfig(draftConfig);
    payload.url = String(payload.url || '').trim();
    if (!payload.url) return null;

    return {
        avatar: character.avatar,
        data: {
            extensions: {
                [EXTENSION_KEY]: payload,
            },
        },
    };
}

async function mergeCharacterAttributes(payload) {
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Failed to save character data: ${response.status}`);
    }
}

async function saveWholeCharacter(character, nextConfig, includeExtensions = true) {
    if (!character?.json_data) throw new Error('Character json_data is not loaded');

    const json = JSON.parse(character.json_data);
    json.data ??= {};
    json.data.extensions ??= {};

    if (nextConfig) json.data.extensions[EXTENSION_KEY] = cloneConfig(nextConfig);
    else delete json.data.extensions[EXTENSION_KEY];

    const formData = new FormData();
    formData.append('avatar_url', character.avatar);
    formData.append('ch_name', json.data?.name || json.name || character.name || '');
    formData.append('description', json.data?.description || json.description || '');
    formData.append('personality', json.data?.personality || json.personality || '');
    formData.append('scenario', json.data?.scenario || json.scenario || '');
    formData.append('first_mes', json.data?.first_mes || json.first_mes || '');
    formData.append('mes_example', json.data?.mes_example || json.mes_example || '');
    formData.append('creator_notes', json.data?.creator_notes || json.creatorcomment || '');
    formData.append('system_prompt', json.data?.system_prompt || '');
    formData.append('post_history_instructions', json.data?.post_history_instructions || '');
    formData.append('tags', JSON.stringify(json.data?.tags || json.tags || []));
    formData.append('creator', json.data?.creator || '');
    formData.append('character_version', json.data?.character_version || '');
    formData.append('alternate_greetings', JSON.stringify(json.data?.alternate_greetings || []));
    formData.append('talkativeness', String(json.data?.extensions?.talkativeness ?? json.talkativeness ?? 0.5));
    formData.append('fav', String(json.data?.extensions?.fav ?? json.fav ?? false));
    formData.append('world', json.data?.extensions?.world || '');
    formData.append('depth_prompt_prompt', json.data?.extensions?.depth_prompt?.prompt || '');
    formData.append('depth_prompt_depth', String(json.data?.extensions?.depth_prompt?.depth ?? 4));
    formData.append('depth_prompt_role', json.data?.extensions?.depth_prompt?.role || 'system');
    formData.append('chat', json.chat || character.chat || '');
    formData.append('create_date', json.create_date || character.create_date || '');
    formData.append('json_data', JSON.stringify(json));
    if (includeExtensions) {
        formData.append('extensions', JSON.stringify(json.data.extensions));
    }

    const response = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Failed to save character data: ${response.status}`);
    }

    return json;
}

function updateCharacterConfigInMemory(character, config, jsonOverride = null) {
    character.data ??= {};
    character.data.extensions ??= {};

    if (config) {
        character.data.extensions[EXTENSION_KEY] = cloneConfig(config);
    } else {
        delete character.data.extensions[EXTENSION_KEY];
    }

    if (jsonOverride) {
        character.json_data = JSON.stringify(jsonOverride);
    } else if (character.json_data) {
        try {
            const json = JSON.parse(character.json_data);
            json.data ??= {};
            json.data.extensions ??= {};
            if (config) json.data.extensions[EXTENSION_KEY] = cloneConfig(config);
            else delete json.data.extensions[EXTENSION_KEY];
            character.json_data = JSON.stringify(json);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to update in-memory json_data`, error);
        }
    }

    const context = getST();
    if (Number(activeCharacterId) === Number(context.characterId) && character.json_data) {
        $('#character_json_data').val(character.json_data);
    }
}

async function saveEditor() {
    const character = getActiveCharacter();
    if (!character || !draftConfig?.url) return;

    readControlsToDraft();
    const payload = buildSavePayload(character);
    if (!payload) return;

    try {
        await mergeCharacterAttributes(payload);
        const savedConfig = payload.data.extensions[EXTENSION_KEY];
        updateCharacterConfigInMemory(character, savedConfig);
        closeEditor();
        refreshRegisteredAvatars();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to save animated avatar`, error);
        setStatus('Failed to save. See browser console.');
    }
}

async function removeConfig() {
    const character = getActiveCharacter();
    if (!character) return;

    try {
        const nextJson = await saveWholeCharacter(character, null, false);
        updateCharacterConfigInMemory(character, null, nextJson);
        closeEditor();
        refreshRegisteredAvatars();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to remove animated avatar`, error);
        setStatus('Failed to remove. See browser console.');
    }
}

export function onActivate() {
    eventSource.on(event_types.APP_READY, async () => {
        try {
            await loadUI();
            patchZoomedAvatarClick();
            scheduleScan();
            applyResponsiveMode();
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to initialize`, error);
        }
    });

    if (globalThis.SillyTavern?.getContext) {
        void loadUI().then(() => {
            patchZoomedAvatarClick();
            scheduleScan();
            applyResponsiveMode();
        }).catch(error => console.error(`[${MODULE_NAME}] Failed to initialize`, error));
    }

    const events = [
        event_types.CHAT_CHANGED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.PERSONA_CHANGED,
    ].filter(Boolean);

    for (const eventType of events) {
        if (eventType === event_types.CHAT_CHANGED) {
            eventSource.on(eventType, () => {
                closeZoomViewer();
                scheduleScan();
            });
        } else {
            eventSource.on(eventType, scheduleScan);
        }
    }
}
