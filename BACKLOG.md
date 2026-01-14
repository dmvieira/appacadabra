Recursos Nativos - Status de Implementação
✅ JÁ IMPLEMENTADOS
Recurso	Bridge	Notas
IA/Gemini	AppacadabraAI	Texto, busca, imagem, áudio, schema
Calendário	AppacadabraCalendar	Criar eventos via URL Google Calendar
Notificações	AppacadabraNotify	Imediatas e agendadas
Localização	AppacadabraLocation	GPS atual
Compartilhar	AppacadabraShare	Texto, URL e arquivos
Contatos	AppacadabraContacts	Listar, buscar, adicionar
Biometria	AppacadabraBiometrics	Face ID, Touch ID, Fingerprint
OAuth	AppacadabraAuth	Abrir URL de autenticação
Sensores	AppacadabraSensors	Acelerômetro, giroscópio, magnetômetro/bússola
localStorage	Nativo	Persistência automática via DB
❌ AINDA NÃO IMPLEMENTADOS
Recurso	Complexidade	Pacote Expo	Cross-platform
Bluetooth	🔴 Alta	expo-bluetooth (não oficial, usar react-native-ble-plx)	⚠️ iOS restrito
NFC	🔴 Alta	react-native-nfc-manager	⚠️ iOS só leitura
Câmera (nativo)	🟡 Média	expo-camera	✅
Galeria/Mídia	🟡 Média	expo-media-library	✅
File Picker	🟢 Baixa	expo-document-picker	✅
Clipboard	🟢 Muito Baixa	expo-clipboard	✅
Vibração/Haptic	🟢 Muito Baixa	expo-haptics	✅
Flashlight	🟢 Baixa	expo-brightness / torch	✅
Battery Info	🟢 Baixa	expo-battery	✅
Device Info	🟢 Baixa	expo-device	✅
Network Info	🟢 Baixa	expo-network	✅
Audio Recording	🟡 Média	expo-av	✅
Audio Playback	🟡 Média	expo-av	✅
Video Player	🟡 Média	expo-av	✅
QR Code Scanner	🟡 Média	expo-barcode-scanner	✅
Print	🟡 Média	expo-print	✅
Mail Composer	🟢 Baixa	expo-mail-composer	✅
SMS	🟢 Baixa	expo-sms	⚠️ iOS abre app
Phone Call	🟢 Muito Baixa	expo-linking (tel:)	✅
Barometer	🟡 Média	expo-sensors	⚠️ Nem todos devices
Pedometer	🟡 Média	expo-sensors	⚠️
AR (Realidade Aumentada)	🔴 Muito Alta	ARCore/ARKit específico	⚠️
Background Tasks	🔴 Alta	expo-background-fetch	⚠️ Limitado
Push Notifications (remoto)	🔴 Alta	expo-notifications + server	✅
In-App Purchases	🔴 Alta	expo-in-app-purchases	✅
Secure Storage	🟡 Média	expo-secure-store	✅
🎯 RECOMENDADOS PARA IMPLEMENTAR (alto valor, baixo esforço)
Clipboard - Copiar/colar texto
Vibração/Haptic - Feedback tátil
File Picker - Selecionar arquivos
QR Code Scanner - Muito útil em apps
Audio Playback - Tocar sons/música
Battery/Device/Network Info - Informações do dispositivo