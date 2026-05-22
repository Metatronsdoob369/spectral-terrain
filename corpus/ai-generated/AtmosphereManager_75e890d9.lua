local AtmosphereManager = {}

-- Constants for default atmospheric properties
local DEFAULT_FOG_START = 0
local DEFAULT_FOG_END = 1000
local DEFAULT_AMBIENT_COLOR = Color3.new(0.5, 0.5, 0.5)
local DEFAULT_LIGHTING_COLOR = Color3.new(1, 1, 1)

-- AtmosphereManager state variables
local currentFogStart = DEFAULT_FOG_START
local currentFogEnd = DEFAULT_FOG_END
local currentAmbientColor = DEFAULT_AMBIENT_COLOR
local currentLightingColor = DEFAULT_LIGHTING_COLOR

local function applyAtmosphereSettings()
    game.Lighting.FogStart = currentFogStart
    game.Lighting.FogEnd = currentFogEnd
    game.Lighting.Ambient = currentAmbientColor
    game.Lighting.OutdoorAmbient = currentLightingColor
end

function AtmosphereManager.setFog(start, finish)
    currentFogStart = start
    currentFogEnd = finish
    applyAtmosphereSettings()
end

function AtmosphereManager.setAmbientColor(color)
    currentAmbientColor = color
    applyAtmosphereSettings()
end

function AtmosphereManager.setLightingColor(color)
    currentLightingColor = color
    applyAtmosphereSettings()
end

function AtmosphereManager.resetToDefault()
    currentFogStart = DEFAULT_FOG_START
    currentFogEnd = DEFAULT_FOG_END
    currentAmbientColor = DEFAULT_AMBIENT_COLOR
    currentLightingColor = DEFAULT_LIGHTING_COLOR
    applyAtmosphereSettings()
end

return AtmosphereManager