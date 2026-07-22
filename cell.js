// File: cell.js
'use strict';

class Cell {
    constructor(gridX, gridY, game) {
        this.game = game;
        this.gridX = gridX;
        this.gridY = gridY;
        this.pixelX = this.gridX * game.cellRes;
        this.pixelY = this.gridY * game.cellRes;
    }

    // No update method needed

    draw(game) {
        const c = game.c;
        const cellRes = game.cellRes;
    
        // Determine which fill color to use based on grid position (checkerboard logic)
        const isEven = (this.gridX + this.gridY) % 2 === 0;
        const fillColor = isEven ? game.themeColors.CELL_FILL_1 : game.themeColors.CELL_FILL_2; // Use the new config colors
    
        c.beginPath();
        c.rect(this.pixelX, this.pixelY, cellRes, cellRes);
        c.fillStyle = fillColor; // Set the fill style
        c.fill(); // Fill the rectangle
    
        // Optional: You could still add a stroke if you want outlines *as well*
        // c.strokeStyle = game.themeColors.GRID_STROKE; // Or a different border color
        // c.lineWidth = CONFIG.RENDER.GRID_LINE_WIDTH;
        // c.stroke();
    }

     resizeUpdate(game) {
        this.pixelX = this.gridX * game.cellRes;
        this.pixelY = this.gridY * game.cellRes;
    }
}