const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs/promises');
const path = require('path');

// Helper to fit text nicely
function formatFittedFont(ctx, text, family, maxSize, minSize, maxWidth, maxHeight) {
    for (let size = maxSize; size >= minSize; size -= 2) {
        ctx.font = `600 ${size}px ${family}`;
        const metrics = ctx.measureText(text);
        const actualHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
        if (metrics.width <= maxWidth && actualHeight <= maxHeight) {
            return `600 ${size}px ${family}`;
        }
    }
    return `600 ${minSize}px ${family}`;
}

function drawCenteredText(ctx, text, family, maxSize, minSize, bounds, color) {
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = formatFittedFont(ctx, text, family, maxSize, minSize, bounds.w, bounds.h);
    ctx.fillText(text, bounds.x + bounds.w / 2, bounds.y + bounds.h / 2 + 5);
}

function drawLeftText(ctx, text, family, maxSize, minSize, bounds, color) {
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = formatFittedFont(ctx, text, family, maxSize, minSize, bounds.w, bounds.h);
    // Add slight offset for ascenders
    ctx.fillText(text, bounds.x, bounds.y + bounds.h / 2 + 5);
}

function addRoundedRectangle(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}

async function renderCard(options) {
    const {
        backgroundPath,
        outputPath,
        avatarPath = '',
        displayName = '',
        serverName = '',
        levelText = 'Level 0',
        repText = 'Rep 0',
        rankText = 'Rank #1',
        scoreText = '0 / 5000 XP',
        nextText = 'Level 1',
        progressRatio = 0.0
    } = options;

    // No media/leveling_card.png: fall back to a plain 1920x1080 card.
    const bgImage = await loadImage(backgroundPath).catch(() => null);
    const canvas = createCanvas(bgImage?.width || 1920, bgImage?.height || 1080);
    const ctx = canvas.getContext('2d');

    // Draw background
    if (bgImage) {
        ctx.drawImage(bgImage, 0, 0);
    } else {
        ctx.fillStyle = '#2b2d31';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const whiteColor = 'rgba(252, 244, 240, 0.92)'; // FromArgb(235, 252, 244, 240)
    const darkColor = 'rgba(83, 74, 92, 0.71)'; // FromArgb(182, 83, 74, 92)
    const textColor = 'rgba(34, 31, 41, 1.0)'; // FromArgb(255, 34, 31, 41)
    const whiteTextColor = 'rgba(250, 250, 252, 1.0)'; // FromArgb(255, 250, 250, 252)
    const blueColor = 'rgba(99, 191, 240, 1.0)'; // FromArgb(255, 99, 191, 240)
    const emptyColor = 'rgba(252, 252, 252, 0.96)'; // FromArgb(245, 252, 252, 252)

    const fontFamily = 'sans-serif'; // Napi-rs default cleanly rendered font

    const avatarBounds = { x: 38, y: 34, w: 546, h: 546, r: 49 };
    const panelOne = { x: 1260, y: 28, w: 600, h: 134, r: 26 };
    const panelTwo = { x: 1260, y: 196, w: 600, h: 134, r: 26 };
    const panelThree = { x: 1260, y: 364, w: 600, h: 134, r: 26 };
    const namePanel = { x: 42, y: 664, w: 640, h: 112, r: 26 };
    const scorePanel = { x: 44, y: 820, w: 520, h: 92, r: 26 };
    const nextPanel = { x: 1342, y: 820, w: 520, h: 92, r: 26 };

    // Function to draw panel
    const drawPanel = (panel, fillStyle) => {
        addRoundedRectangle(ctx, panel.x, panel.y, panel.w, panel.h, panel.r);
        ctx.fillStyle = fillStyle;
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(32, 28, 35, 0.41)';
        ctx.stroke();
    };

    drawPanel(avatarBounds, whiteColor);
    [panelOne, panelTwo, panelThree, namePanel, scorePanel, nextPanel].forEach(p => drawPanel(p, darkColor));

    // Avatar
    try {
        if (avatarPath) {
            const avatarImg = await loadImage(avatarPath);
            ctx.save();
            addRoundedRectangle(ctx, avatarBounds.x, avatarBounds.y, avatarBounds.w, avatarBounds.h, avatarBounds.r);
            ctx.clip();
            const scale = Math.max(avatarBounds.w / avatarImg.width, avatarBounds.h / avatarImg.height);
            const drawWidth = avatarImg.width * scale;
            const drawHeight = avatarImg.height * scale;
            const drawX = avatarBounds.x + (avatarBounds.w - drawWidth) / 2;
            const drawY = avatarBounds.y + (avatarBounds.h - drawHeight) / 2;
            ctx.drawImage(avatarImg, drawX, drawY, drawWidth, drawHeight);
            ctx.restore();

            // Re-stroke border
            addRoundedRectangle(ctx, avatarBounds.x, avatarBounds.y, avatarBounds.w, avatarBounds.h, avatarBounds.r);
            ctx.lineWidth = 4;
            ctx.strokeStyle = 'rgba(32, 28, 35, 0.41)';
            ctx.stroke();
        } else {
            drawCenteredText(ctx, 'No Avatar', fontFamily, 62, 36, avatarBounds, textColor);
        }
    } catch (e) {
        console.error("Failed to load avatar:", e);
    }

    // Texts
    drawCenteredText(ctx, levelText, fontFamily, 68, 38, panelOne, whiteTextColor);
    drawCenteredText(ctx, repText, fontFamily, 68, 38, panelTwo, whiteTextColor);
    drawCenteredText(ctx, rankText, fontFamily, 68, 38, panelThree, whiteTextColor);

    if (displayName) {
        drawLeftText(ctx, displayName, fontFamily, 66, 36, { x: namePanel.x + 28, y: namePanel.y + 4, w: namePanel.w - 56, h: 66 }, whiteTextColor);
    }
    if (serverName) {
        drawLeftText(ctx, serverName, fontFamily, 42, 24, { x: namePanel.x + 30, y: namePanel.y + 66, w: namePanel.w - 60, h: 34 }, whiteTextColor);
    }

    drawCenteredText(ctx, scoreText, fontFamily, 58, 30, scorePanel, whiteTextColor);
    drawCenteredText(ctx, nextText, fontFamily, 58, 30, nextPanel, whiteTextColor);

    // --- LEVELING GRAPH CONFIGURATION ---
    // You can easily adjust the spacing, sizing, and slant of the XP pills here:
    const segmentCount = 16;      // Number of XP pills
    const gap = 10.0;             // Gap (spacing) between each XP pill

    const barHeight = 106.0;      // Height (thickness) of the XP pills
    const barWidth = 1888.0;      // Total width of the overall progress bar
    const barX = 16.0;            // Left position of the bar
    const barY = 956.0;           // Top position of the bar

    const slantDegrees = 15.0;    // How much the XP pills lean (slant)
    const maxRadius = 16.0;       // Maximum roundness of the pill corners
    const borderThickness = 6;    // Thickness of the border around each pill
    const borderColor = 'rgba(0, 0, 0, 1)'; // Color of the pill border
    // ------------------------------------

    const segmentWidth = (barWidth - ((segmentCount - 1) * gap)) / segmentCount;
    const clampedProgress = Math.max(0.0, Math.min(1.0, progressRatio));
    const filledSegments = clampedProgress * segmentCount;

    for (let index = 0; index < segmentCount; index++) {
        const segmentX = barX + (index * (segmentWidth + gap));
        const radius = Math.min(maxRadius, barHeight / 3.8);

        const slantOffset = Math.tan(slantDegrees * Math.PI / 180.0) * barHeight;
        const usableSlant = Math.min(slantOffset, Math.max(0.0, segmentWidth * 0.45));
        const innerWidth = Math.max(1.0, segmentWidth - usableSlant);

        const drawSegment = (fillColor) => {
            ctx.save();
            ctx.translate(segmentX + usableSlant, barY);
            const sx = -usableSlant / barHeight;
            ctx.transform(1, 0, sx, 1, 0, 0);

            addRoundedRectangle(ctx, 0, 0, innerWidth, barHeight, radius);
            ctx.fillStyle = fillColor;
            ctx.fill();
            ctx.lineWidth = borderThickness;
            ctx.strokeStyle = borderColor;
            ctx.stroke();

            ctx.restore();
        };

        // Draw background segment
        drawSegment(emptyColor);

        const segmentFillRatio = Math.max(0.0, Math.min(1.0, filledSegments - index));
        if (segmentFillRatio > 0.0) {
            if (segmentFillRatio >= 0.999) {
                drawSegment(blueColor);
            } else {
                ctx.save();
                // create transformed clip path
                ctx.translate(segmentX + usableSlant, barY);
                const sx = -usableSlant / barHeight;
                ctx.transform(1, 0, sx, 1, 0, 0);
                addRoundedRectangle(ctx, 0, 0, innerWidth, barHeight, radius);
                ctx.clip();

                // reset transform physically to draw exact rectangle percentage
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                const fillWidth = Math.max(0.0, segmentWidth * segmentFillRatio);
                ctx.fillStyle = blueColor;
                ctx.fillRect(segmentX, barY, fillWidth, barHeight);
                ctx.restore();

                // re-draw border
                drawSegment('transparent');
            }
        }
    }

    const buffer = await canvas.encode('png');
    await fs.writeFile(outputPath, buffer);
}

module.exports = { renderCard };
