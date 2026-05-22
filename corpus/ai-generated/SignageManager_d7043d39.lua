local SignageManager = {}

local signs = {} -- Table to store all the sign instances
local activeSigns = {} -- Table to keep track of active signs
local signTemplates = {} -- Pre-defined sign templates for the Chaos Metropolis theme

-- Function to initialize and cache sign templates
function SignageManager.initializeTemplates()
    signTemplates = {
        neonRedSign = Instance.new("Part"),
        obsidianBillboard = Instance.new("BillboardGui"),
        -- Add more templates as needed
    }
    -- Set properties for each template
    signTemplates.neonRedSign.BrickColor = BrickColor.new("Neon orange")
    signTemplates.neonRedSign.Size = Vector3.new(4, 2, 0.2)

    signTemplates.obsidianBillboard.Size = UDim2.new(0, 300, 0, 150)
    signTemplates.obsidianBillboard.StudsOffset = Vector3.new(0, 5, 0)
end

-- Function to create a new sign instance from a template
function SignageManager.createSign(template, position, rotation, message)
    local sign = signTemplates[template]:Clone()
    sign.Position = position
    sign.Orientation = rotation

    if template == "obsidianBillboard" then
        local textLabel = Instance.new("TextLabel", sign)
        textLabel.Size = UDim2.new(1, 0, 1, 0)
        textLabel.Text = message
        textLabel.TextColor3 = Color3.fromRGB(255, 0, 0) -- Neon red text
        textLabel.BackgroundTransparency = 1
    end

    table.insert(signs, sign)
    return sign
end

-- Function to display a sign
function SignageManager.displaySign(sign)
    sign.Parent = workspace
    table.insert(activeSigns, sign)
end

-- Function to remove a sign from display
function SignageManager.removeSign(sign)
    for i, activeSign in ipairs(activeSigns) do
        if activeSign == sign then
            table.remove(activeSigns, i)
            sign:Destroy()
            break
        end
    end
end

-- Function to update the message on a sign
function SignageManager.updateSignMessage(sign, newMessage)
    if sign:IsA("BillboardGui") then
        local textLabel = sign:FindFirstChild("TextLabel")
        if textLabel then
            textLabel.Text = newMessage
        end
    end
end

-- Function to refresh all active signs
function SignageManager.refreshAllSigns()
    for _, sign in ipairs(activeSigns) do
        sign:Destroy()
    end
    activeSigns = {}
    
    for _, sign in ipairs(signs) do
        SignageManager.displaySign(sign:Clone())
    end
end

SignageManager.initializeTemplates()

return SignageManager