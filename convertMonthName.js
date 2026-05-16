const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function convertMonthName(month) {
  if (!month) return '';
  
  // لو جاه رقم يرجع الاسم
  if (typeof month === 'number' || !isNaN(month)) {
    const num = parseInt(month, 10);
    if (num >= 1 && num <= 12) {
      return months[num - 1];
    }
  }
  
  // لو جاه اسم يرجع الرقم
  const index = months.findIndex(m => m.toLowerCase() === month.toLowerCase());
  return index !== -1 ? index + 1 : '';
}

module.exports = convertMonthName;