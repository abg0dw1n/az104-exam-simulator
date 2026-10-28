# Local AZ-104 narration rendering

The speech renderer uses the Azure Speech REST API from a local Node.js process. It reads the Speech key and region from environment variables, creates one MP3 per AZ-104 module, and never writes the key to a file. The default voice is the standard Neural voice `en-US-AndrewNeural`; set `AZURE_SPEECH_VOICE` to another standard Neural voice if desired. Do not choose an HD voice when staying within the Speech F0 free tier.

## Requirements

- Node.js 18 or newer (for built-in `fetch`)
- An Azure Speech resource configured with the **Free F0** pricing tier
- The resource key and region (for example, `eastus`)

The renderer makes one real-time synthesis request per module. It does not switch tiers or create Azure resources. Speech charges depend on the Azure resource's tier and usage; keep the resource on F0 and verify the Azure pricing page before rendering.

## Run from PowerShell

Set these values in the same PowerShell window you will use for the command. Substitute your own key; never commit it or paste it into chat:

```powershell
$env:AZURE_SPEECH_KEY = "your-key"
$env:AZURE_SPEECH_REGION = "eastus"
```

The renderer defaults to Andrew (`en-US-AndrewNeural`). To choose another standard Neural voice instead, set:

```powershell
$env:AZURE_SPEECH_VOICE = "en-US-AvaNeural"
```

From the repository folder, run:

```powershell
npm run speech:az104
```

The files are written to `exams/az-104/media/` as `D1.mp3`, `D2.mp3`, and so on. The environment variables disappear when you close PowerShell. The key is not stored in the repository. Generated MP3s can be reviewed locally before deciding whether to add them to version control.
