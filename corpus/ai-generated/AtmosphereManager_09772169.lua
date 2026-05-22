local AtmosphereManager = {}
AtmosphereManager.__index = AtmosphereManager

local Lighting = game:GetService("Lighting")
local RunService = game:GetService("RunService")

function AtmosphereManager.new()
    local self = setmetatable({}, AtmosphereManager)
    self:initializeDefaults()
    return self
end

function AtmosphereManager:initializeDefaults()
    self.timeOfDay = 14
    self.brightness = 1.0
    self.atmosphereDensity = 0.3
    self.saturation = 0.8
    self.streetNeonColor = Color3.new(1, 0, 0)
end

function AtmosphereManager:setTimeOfDay(hour)
    if hour >= 0 and hour <= 24 then
        self.timeOfDay = hour
        Lighting.ClockTime = hour
    end
end

function AtmosphereManager:setBrightness(value)
    if value >= 0 and value <= 2 then
        self.brightness = value
        Lighting.Brightness = value
    end
end

function AtmosphereManager:setAtmosphereDensity(density)
    if density >= 0 and density <= 1 then
        self.atmosphereDensity = density
        if Lighting:FindFirstChildOfClass("Atmosphere") then
            Lighting:FindFirstChildOfClass("Atmosphere").Density = density
        end
    end
end

function AtmosphereManager:setSaturation(value)
    if value >= 0 and value <= 1 then
        self.saturation = value
        Lighting.ColorShift_Top = Color3.fromHSV(0, value, 1)
    end
end

function AtmosphereManager:setStreetNeonColor(color)
    self.streetNeonColor = color
end

function AtmosphereManager:update(dt)
    -- Example dynamic atmosphere update logic can go here
    -- e.g., animate neon pulsing or adjust settings based on game events
end

function AtmosphereManager:start()
    self:applySettings()
    RunService.Heartbeat:Connect(function(dt)
        self:update(dt)
    end)
end

function AtmosphereManager:applySettings()
    self:setTimeOfDay(self.timeOfDay)
    self:setBrightness(self.brightness)
    self:setAtmosphereDensity(self.atmosphereDensity)
    self:setSaturation(self.saturation)
    -- Apply neon color to any relevant models or parts in the game
end

return AtmosphereManager