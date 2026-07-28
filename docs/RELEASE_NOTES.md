## Version Name
Background Generation Reliability Fix

<en-US>
• Spell generation now recovers in ~3 min if Android kills the background service (was up to 20 min on Xiaomi, Huawei, Samsung)
• WorkManager retry now uses expedited scheduling with graceful downgrade under Doze mode
• Stale job detection on re-open is now faster: 2 min threshold instead of 15 min
</en-US>

<pt-BR>
• A geração de feitiços agora se recupera em ~3 min se o Android encerrar o serviço em segundo plano (antes podia demorar até 20 min em Xiaomi, Huawei, Samsung)
• O WorkManager agora usa agendamento expedito com degradação graciosa no modo Doze
• A deteção de tarefas paradas ao reabrir o app ficou mais rápida: limite de 2 min em vez de 15 min
</pt-BR>

<es-419>
• La generación de hechizos se recupera en ~3 min si Android mata el servicio en segundo plano (antes hasta 20 min en Xiaomi, Huawei, Samsung)
• WorkManager ahora usa programación expedita con degradación elegante en modo Doze
• La detección de tareas colgadas al reabrir la app es más rápida: umbral de 2 min en lugar de 15 min
</es-419>

<es-ES>
• La generación de hechizos se recupera en ~3 min si Android mata el servicio en segundo plano (antes hasta 20 min en Xiaomi, Huawei, Samsung)
• WorkManager ahora usa programación expedita con degradación elegante en modo Doze
• La detección de tareas bloqueadas al reabrir la app es más rápida: umbral de 2 min en lugar de 15 min
</es-ES>

<fr-FR>
• La génération de sorts se rétablit en ~3 min si Android tue le service en arrière-plan (jusqu'à 20 min avant sur Xiaomi, Huawei, Samsung)
• WorkManager utilise désormais la planification expéditée avec dégradation gracieuse en mode Doze
• La détection des tâches bloquées à la réouverture de l'app est plus rapide : seuil de 2 min au lieu de 15 min
</fr-FR>

<fr-CA>
• La génération de sorts se rétablit en ~3 min si Android arrête le service en arrière-plan (pouvait prendre jusqu'à 20 min sur Xiaomi, Huawei, Samsung)
• WorkManager utilise maintenant la planification expéditée avec dégradation gracieuse en mode Doze
• La détection des tâches bloquées à la réouverture de l'app est plus rapide : seuil de 2 min au lieu de 15 min
</fr-CA>

<de-DE>
• Die Zaubergenerierung erholt sich jetzt in ~3 Min., wenn Android den Hintergrunddienst beendet (vorher bis zu 20 Min. auf Xiaomi, Huawei, Samsung)
• WorkManager nutzt jetzt expedited Scheduling mit graceful Downgrade im Doze-Modus
• Erkennung hängender Aufgaben beim erneuten Öffnen der App ist schneller: 2 Min. statt 15 Min.
</de-DE>

<it-IT>
• La generazione degli incantesimi ora si ripristina in ~3 min se Android termina il servizio in background (prima fino a 20 min su Xiaomi, Huawei, Samsung)
• WorkManager ora usa la pianificazione spedita con degradazione elegante in modalità Doze
• Il rilevamento dei job bloccati alla riapertura dell'app è più veloce: soglia di 2 min invece di 15 min
</it-IT>

<ja-JP>
• AndroidがバックグラウンドサービスをKillしてもスペル生成が約3分で復帰（Xiaomi・Huawei・Samsungでは以前最大20分かかっていた）
• WorkManagerがDozeモード下でのグレースフルダウングレード付き優先スケジューリングを使用
• アプリ再起動時の停止ジョブ検出が高速化：15分から2分に短縮
</ja-JP>

<zh-CN>
• 即使 Android 终止后台服务，法术生成现在约 3 分钟即可恢复（此前在小米、华为、三星设备上最长需 20 分钟）
• WorkManager 现在使用优先调度，并在 Doze 模式下优雅降级
• 重新打开 App 时停滞任务的检测速度更快：阈值从 15 分钟缩短至 2 分钟
</zh-CN>

<ko-KR>
• Android가 백그라운드 서비스를 종료해도 주문 생성이 약 3분 내에 복구됩니다 (Xiaomi, Huawei, Samsung에서 이전에는 최대 20분 소요)
• WorkManager가 Doze 모드에서 우아한 다운그레이드와 함께 신속 스케줄링을 사용
• 앱 재실행 시 중단된 작업 감지 속도 향상: 15분에서 2분으로 단축
</ko-KR>

<ar>
• يتعافى توليد التعاويذ الآن في ~3 دقائق إذا أوقف Android الخدمة في الخلفية (كان يستغرق حتى 20 دقيقة على Xiaomi وHuawei وSamsung)
• يستخدم WorkManager الآن جدولة سريعة مع تخفيض سلس في وضع Doze
• اكتشاف المهام المتوقفة عند إعادة فتح التطبيق أسرع: عتبة دقيقتين بدلاً من 15 دقيقة
</ar>

<hi-IN>
• Android द्वारा बैकग्राउंड सर्विस बंद होने पर Spell generation ~3 मिनट में रिकवर हो जाती है (Xiaomi, Huawei, Samsung पर पहले 20 मिनट तक लगते थे)
• WorkManager अब Doze मोड में graceful downgrade के साथ expedited scheduling का उपयोग करता है
• App दोबारा खोलने पर रुके हुए jobs की पहचान तेज हुई: 15 मिनट की जगह 2 मिनट की सीमा
</hi-IN>

<ru-RU>
• Генерация заклинаний теперь восстанавливается за ~3 мин., если Android завершает фоновый сервис (ранее до 20 мин. на Xiaomi, Huawei, Samsung)
• WorkManager теперь использует ускоренное планирование с плавным понижением в режиме Doze
• Обнаружение зависших задач при повторном открытии приложения ускорено: порог 2 мин. вместо 15 мин.
</ru-RU>

<tr-TR>
• Android arka plan hizmetini sonlandırırsa büyü üretimi artık ~3 dakikada kurtarılıyor (Xiaomi, Huawei, Samsung'da önceden 20 dakikaya kadar sürebiliyordu)
• WorkManager artık Doze modunda zarif düşürme ile hızlandırılmış zamanlama kullanıyor
• Uygulamayı yeniden açarken takılı kalan görevlerin tespiti hızlandı: 15 dakika yerine 2 dakika eşiği
</tr-TR>

<nl-NL>
• Spreukcreatie herstelt nu in ~3 min als Android de achtergrondservice beëindigt (was tot 20 min op Xiaomi, Huawei, Samsung)
• WorkManager gebruikt nu versnelde planning met elegante downgrade in Doze-modus
• Detectie van vastgelopen taken bij heropenen van de app is sneller: drempel van 2 min in plaats van 15 min
</nl-NL>

<pl-PL>
• Generowanie zaklęć odtwarza się teraz w ~3 min, jeśli Android zatrzyma usługę w tle (wcześniej do 20 min na Xiaomi, Huawei, Samsung)
• WorkManager używa teraz przyspieszonego planowania z elegancką degradacją w trybie Doze
• Wykrywanie zawieszonych zadań przy ponownym otwarciu aplikacji jest szybsze: próg 2 min zamiast 15 min
</pl-PL>

<vi>
• Tạo phép thuật giờ phục hồi trong ~3 phút nếu Android tắt dịch vụ nền (trước đây lên đến 20 phút trên Xiaomi, Huawei, Samsung)
• WorkManager sử dụng lịch trình ưu tiên với giảm cấp duyên dáng ở chế độ Doze
• Phát hiện các công việc bị treo khi mở lại ứng dụng nhanh hơn: ngưỡng 2 phút thay vì 15 phút
</vi>

<th>
• การสร้าง Spell ฟื้นตัวภายใน ~3 นาที หาก Android ปิด background service (เดิมอาจใช้เวลาถึง 20 นาทีบน Xiaomi, Huawei, Samsung)
• WorkManager ใช้การจัดกำหนดการแบบเร่งด่วนพร้อม graceful downgrade ในโหมด Doze
• การตรวจจับ job ที่ค้างเมื่อเปิดแอปอีกครั้งเร็วขึ้น: threshold 2 นาที แทนที่จะเป็น 15 นาที
</th>
